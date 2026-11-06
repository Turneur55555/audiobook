-- Synchronisation des positions d'écoute entre appareils (PC, iPhone…).
-- À exécuter une seule fois dans Supabase → SQL Editor. Ré-exécutable sans risque.
--
-- Principe : chaque appareil connaît un « code de synchronisation » (16 caractères aléatoires).
-- Les appareils qui partagent le même code partagent leurs positions. Pas de compte, pas d'e-mail.
-- La table n'est accessible que par les deux fonctions ci-dessous (aucun accès direct).

create table if not exists public.listening_sync (
  sync_code   text not null check (sync_code ~ '^[A-Z2-7]{16}$'),
  chapter_id  text not null check (length(chapter_id) between 1 and 64),
  position    double precision not null default 0,
  duration    double precision,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (sync_code, chapter_id)
);

alter table public.listening_sync enable row level security;
revoke all on table public.listening_sync from anon, authenticated;

-- Lire toutes les positions d'un code.
create or replace function public.sync_pull(p_code text)
returns table (cid text, pos double precision, dur double precision, is_done boolean, changed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.chapter_id, s.position, s.duration, s.done, s.updated_at
  from public.listening_sync s
  where p_code ~ '^[A-Z2-7]{16}$' and s.sync_code = p_code;
$$;

-- Envoyer des positions : [{ "id", "position", "duration", "done", "updatedAt" (ms) }, …].
-- La plus récente gagne ; une date dans le futur est ramenée à maintenant.
create or replace function public.sync_push(p_code text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_code !~ '^[A-Z2-7]{16}$' then
    raise exception 'code de synchronisation invalide';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'liste invalide';
  end if;

  with items as (
    select distinct on (left(i->>'id', 64))
      left(i->>'id', 64) as chapter_id,
      least(greatest(coalesce((i->>'position')::double precision, 0), 0), 86400) as position,
      case when jsonb_typeof(i->'duration') = 'number'
           then least(greatest((i->>'duration')::double precision, 0), 86400) end as duration,
      coalesce((i->>'done')::boolean, false) as done,
      least(to_timestamp(coalesce((i->>'updatedAt')::double precision, 0) / 1000.0), now()) as updated_at
    from jsonb_array_elements(p_items) as i
    where jsonb_typeof(i) = 'object'
      and length(coalesce(i->>'id', '')) between 1 and 64
      and jsonb_typeof(i->'position') = 'number'
    order by left(i->>'id', 64), (i->>'updatedAt')::double precision desc nulls last
  )
  insert into public.listening_sync as s (sync_code, chapter_id, position, duration, done, updated_at)
  select p_code, chapter_id, position, duration, done, updated_at from items
  on conflict (sync_code, chapter_id) do update
    set position = excluded.position,
        duration = coalesce(excluded.duration, s.duration),
        done = excluded.done,
        updated_at = excluded.updated_at
    where s.updated_at < excluded.updated_at;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.sync_pull(text) from public;
revoke all on function public.sync_push(text, jsonb) from public;
grant execute on function public.sync_pull(text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
