const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function json(data,status=200){
  return Response.json(data,{status,headers:corsHeaders});
}
async function checkRateLimit(request,env){
  if(!env.MY_RATE_LIMITER)return true;
  const ip=request.headers.get("CF-Connecting-IP")||"unknown";
  const {success}=await env.MY_RATE_LIMITER.limit({key:ip});
  return success;
}
function getBearerToken(request){
  const value=request.headers.get("Authorization")||"";
  return value.replace(/^Bearer\s+/i,"").trim();
}
async function verifyUser(request,env){
  const token=getBearerToken(request);
  if(!token||!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY)return null;
  const response=await fetch(env.SUPABASE_URL.replace(/\/$/,"")+"/auth/v1/user",{
    headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:"Bearer "+token}
  });
  if(!response.ok)return null;
  const user=await response.json();
  return user?.id?user:null;
}
async function supabaseServiceRequest(env,path,options={}){
  const key=env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw new Error("Supabase service key is not configured.");
  const response=await fetch(env.SUPABASE_URL.replace(/\/$/,"")+path,{
    ...options,
    headers:{
      apikey:key,
      Authorization:"Bearer "+key,
      "Content-Type":"application/json",
      ...(options.headers||{})
    }
  });
  const text=await response.text();
  let data=null;
  try{data=text?JSON.parse(text):null;}catch(e){data=text;}
  if(!response.ok)throw new Error(typeof data==="string"?data:(data?.message||data?.error||"Supabase request failed: "+response.status));
  return data;
}
function cleanHistory(body){
  const history=Array.isArray(body.messages)?body.messages:(Array.isArray(body.history)?body.history:[]);
  const valid=history.filter(item=>
    item&&["user","assistant"].includes(item.role)&&
    typeof item.content==="string"&&item.content.trim()
  ).slice(-8).map(item=>({role:item.role,content:item.content.slice(-3000)}));
  const last=valid[valid.length-1];
  if(!last||last.role!=="user"||last.content!==body.message){
    valid.push({role:"user",content:body.message.trim()});
  }
  return valid;
}
function buildMessages(message,history,imageDataUrl=null){
  const validHistory=history||[];
  const messages=[
    {role:"system",content:
      "You are NEXUS AI, a helpful, intelligent and friendly AI assistant. "+
      "Answer clearly and accurately. Remember the conversation context. "+
      "Use headings, bullet points and code blocks when useful. "+
      "For programming questions, provide working and understandable code. "+
      "If you are unsure about something, say so honestly."
    },
    ...validHistory
  ];
  if(imageDataUrl){
    const lastUserIndex=messages.map(item=>item.role).lastIndexOf("user");
    if(lastUserIndex<0)throw new Error("An image must be sent with a user message.");
    messages[lastUserIndex]={
      role:"user",
      content:[
        {type:"image_url",image_url:{url:imageDataUrl,detail:"high"}},
        {type:"text",text:messages[lastUserIndex].content}
      ]
    };
  }
  return messages;
}
async function generateReply(env,message,history,imageDataUrl=null){
  if(!env.AI)throw new Error("AI binding is not configured.");
  const result=await env.AI.run(MODEL,{messages:buildMessages(message,history,imageDataUrl),max_tokens:2048});
  return result.choices?.[0]?.message?.content||result.response||"No response generated.";
}
async function handleCreateJob(request,env){
  if(!env.AI_QUEUE||!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY||!env.SUPABASE_SERVICE_ROLE_KEY){
    return json({fallback:true,error:"Background queue is not configured yet. Existing direct AI mode is still available."},503);
  }
  const user=await verifyUser(request,env);
  if(!user)return json({error:"Please sign in again."},401);
  const body=await request.json();
  if(typeof body.message!=="string"||!body.message.trim())return json({error:"Please enter a message."},400);
  if(body.message.length>6000)return json({error:"Message is too long."},400);
  if(typeof body.chatId!=="string"||!/^[0-9a-f-]{36}$/i.test(body.chatId))return json({error:"Invalid chat reference."},400);
  const history=cleanHistory(body);
  const payload={message:body.message.trim(),messages:history};
  if(new TextEncoder().encode(JSON.stringify(payload)).length>120000){
    return json({error:"This conversation is too large for background processing. Start a new chat or shorten the recent context."},413);
  }
  const chatRows=await supabaseServiceRequest(env,
    "/rest/v1/chats?id=eq."+encodeURIComponent(body.chatId)+
    "&user_id=eq."+encodeURIComponent(user.id)+"&select=id&limit=1");
  if(!Array.isArray(chatRows)||!chatRows.length)return json({error:"Chat not found for this account."},404);
  const jobId=crypto.randomUUID();
  await supabaseServiceRequest(env,"/rest/v1/ai_jobs",{
    method:"POST",
    headers:{Prefer:"return=minimal"},
    body:JSON.stringify({id:jobId,user_id:user.id,chat_id:body.chatId,status:"queued"})
  });
  try{
    await env.AI_QUEUE.send({jobId,userId:user.id,message:payload.message,messages:payload.messages});
  }catch(error){
    await supabaseServiceRequest(env,"/rest/v1/ai_jobs?id=eq."+jobId,{
      method:"PATCH",
      body:JSON.stringify({status:"failed",error:"Could not add the task to the background queue.",updated_at:new Date().toISOString()})
    });
    throw error;
  }
  return json({jobId,status:"queued"},202);
}
async function handleGetJob(request,env,jobId){
  const user=await verifyUser(request,env);
  if(!user)return json({error:"Please sign in again."},401);
  const rows=await supabaseServiceRequest(env,
    "/rest/v1/ai_jobs?id=eq."+encodeURIComponent(jobId)+
    "&user_id=eq."+encodeURIComponent(user.id)+
    "&select=id,chat_id,status,reply,error,created_at&limit=1");
  if(!Array.isArray(rows)||!rows.length)return json({error:"Background task not found."},404);
  return json(rows[0]);
}
export default {
  async fetch(request,env){
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders});
    const url=new URL(request.url);
    try{
      if(request.method==="POST"&&!await checkRateLimit(request,env))return json({error:"Too many requests. Please try again later."},429);
      if(url.pathname==="/jobs"&&request.method==="POST")return await handleCreateJob(request,env);
      const jobMatch=url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/i);
      if(jobMatch&&request.method==="GET")return await handleGetJob(request,env,jobMatch[1]);
      if(request.method!=="POST")return json({error:"Method not allowed"},405);

      // Existing direct request path is retained for image requests and safe fallback.
      const body=await request.json();
      if(typeof body.message!=="string"||!body.message.trim())return json({error:"Please enter a message"},400);
      if(body.message.length>6000)return json({error:"Message is too long"},400);
      const history=cleanHistory(body);
      const imageDataUrl=body.imageDataUrl;
      if(imageDataUrl!==undefined&&imageDataUrl!==null){
        if(typeof imageDataUrl!=="string"||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(imageDataUrl)||imageDataUrl.length>2500000){
          return json({error:"Invalid image. Please upload a JPEG image smaller than the supported limit."},400);
        }
      }
      const reply=await generateReply(env,body.message.trim(),history,imageDataUrl||null);
      return json({reply});
    }catch(error){
      return json({error:"AI service error",details:error.message||"Unknown error"},500);
    }
  },
  async queue(batch,env){
    for(const message of batch.messages){
      const job=message.body||{};
      try{
        await supabaseServiceRequest(env,"/rest/v1/ai_jobs?id=eq."+encodeURIComponent(job.jobId),{
          method:"PATCH",body:JSON.stringify({status:"processing",updated_at:new Date().toISOString()})
        });
        const reply=await generateReply(env,job.message,job.messages||[]);
        await supabaseServiceRequest(env,"/rest/v1/ai_jobs?id=eq."+encodeURIComponent(job.jobId),{
          method:"PATCH",body:JSON.stringify({status:"completed",reply, error:null,updated_at:new Date().toISOString()})
        });
        message.ack();
      }catch(error){
        const attempts=Number(message.attempts||1);
        if(attempts<3){
          message.retry({delaySeconds:Math.min(30,attempts*10)});
        }else{
          try{
            await supabaseServiceRequest(env,"/rest/v1/ai_jobs?id=eq."+encodeURIComponent(job.jobId),{
              method:"PATCH",body:JSON.stringify({status:"failed",error:error.message||"AI task failed.",updated_at:new Date().toISOString()})
            });
          }catch(updateError){console.error("Could not save failed job status:",updateError);}
          message.ack();
        }
      }
    }
  }
};
