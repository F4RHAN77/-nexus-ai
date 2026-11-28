# NEXUS AI — Project Status

Last audited: 2026-11-28

## Live project links
- Website: https://f4rhan77.github.io/-nexus-ai/
- GitHub repository: https://github.com/F4RHAN77/-nexus-ai
- Supabase project dashboard: https://supabase.com/dashboard/project/hrtbmmahyxrwppynbrvr
- Cloudflare Worker endpoint: https://nexus-ai.pagalkudi14447-6d9.workers.dev

## Verified architecture
- Static frontend hosted with GitHub Pages.
- Cloudflare Worker handles AI requests using Workers AI.
- Supabase Auth handles account sign-in and recovery flows.
- Supabase database stores chat history in `public.chats`.
- Worker uses the `AI` binding and `MY_RATE_LIMITER` binding.
- Frontend uses a Supabase publishable key; no service-role key is embedded in the frontend.

## Completed in the 2026-11-28 audit
- Confirmed Supabase project status is `ACTIVE_HEALTHY`.
- Confirmed `public.chats` has RLS enabled.
- Confirmed the owner policy scopes chat rows to `auth.uid() = user_id` for authenticated users.
- Confirmed 26 chat rows across 8 distinct user IDs at audit time.
- Made `chats.user_id` NOT NULL.
- Revoked unnecessary `TRUNCATE`, `REFERENCES`, and `TRIGGER` privileges from `anon`, `authenticated`, and `service_role` on `public.chats`.
- Added a composite index on `(user_id, updated_at DESC)` for the chat-history query.
- Verified RLS remains enabled, the owner policy remains present, the extra privileges are gone, and the chat rows remain present.
- Security advisor still reports Leaked Password Protection disabled.
- Performance advisor reports the new index as unused immediately after creation; this is informational and may change after normal traffic.

## Owner actions still required
1. Open the Supabase project dashboard and review Authentication password settings. Enable leaked-password protection if the project plan supports it. Supabase documents this feature as available on Pro and above:
   https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
2. Verify the signup confirmation and password-recovery email templates. The current frontend offers signup OTP, recovery OTP, and reset-link flows, but the actual delivered email appearance and token format must be tested with a real inbox.
3. Configure/verify custom SMTP if NEXUS AI is going to send production emails. Supabase recommends custom SMTP for production:
   https://supabase.com/docs/guides/auth#email-sending
4. Test sign-up, email OTP, login, logout, recovery OTP, reset link, and password update using a test account.
5. Test chat isolation with two separate test accounts (each account should only see its own chat history).
6. Test the updated website on mobile and desktop after GitHub Pages finishes publishing.

## Notes
- Never put a Supabase service-role key, Cloudflare API token, database password, or SMTP password in this repository or in frontend code.
- A publishable Supabase key is intended for frontend use; table access must remain protected by RLS.
- This document records verified checks and remaining manual tests; it does not claim the entire app is production-ready.
