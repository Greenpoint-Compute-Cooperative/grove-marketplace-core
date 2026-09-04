#!/bin/sh
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database.}"

for role in anon authenticated service_role; do
  if [ "$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select count(*) from pg_roles where rolname = '$role'")" = "0" ]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "create role $role nologin" >/dev/null
  fi
done

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb
);
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
SQL

for migration in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

for test_file in supabase/tests/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$test_file"
done
