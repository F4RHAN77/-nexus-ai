# NEXUS AI

An all-in-one AI workspace for students and everyday productivity.

## Open the project
- **Live website:** https://f4rhan77.github.io/-nexus-ai/
- **Project audit and remaining tasks:** [PROJECT_STATUS.md](./PROJECT_STATUS.md)

## Current architecture
- Frontend: HTML, CSS and JavaScript hosted on GitHub Pages.
- AI backend: Cloudflare Workers AI.
- Authentication and chat history: Supabase Auth + Postgres.

## Important
Never commit private API tokens, Supabase service-role keys, database passwords, or SMTP credentials. The browser app must use only a publishable Supabase key and rely on Row Level Security for user data access.
