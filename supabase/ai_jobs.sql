-- Run this once in the Supabase SQL Editor.
-- AI replies are written by the Cloudflare Worker using its server-side service key.
-- Signed-in users can read only their own background-job status/results.

create table if not exists public.ai_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed')),
  reply text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_jobs_user_created_idx
  on public.ai_jobs (user_id, created_at desc);

alter table public.ai_jobs enable row level security;

drop policy if exists "Users can read their own AI jobs" on public.ai_jobs;
create policy "Users can read their own AI jobs"
  on public.ai_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on table public.ai_jobs from anon, authenticated;
grant select on table public.ai_jobs to authenticated;
grant all on table public.ai_jobs to service_role;
