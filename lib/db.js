// Postgres access. Without DATABASE_URL the server still runs, with accounts,
// ratings and match history switched off.
'use strict';

const url = process.env.DATABASE_URL;
const pool = url ? new (require('pg').Pool)({ connectionString: url, max: 5 }) : null;

const SCHEMA = `
create table if not exists users (
  id serial primary key,
  username text not null,
  username_lower text not null unique,
  password_hash text,
  google_sub text unique,
  email text,
  rating real not null default 1500,
  games integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists games (
  id serial primary key,
  tc text,
  rated boolean not null,
  red_id integer references users(id),
  blue_id integer references users(id),
  red_name text,
  blue_name text,
  red_rating integer,
  blue_rating integer,
  red_diff integer,
  blue_diff integer,
  winner text not null,
  reason text not null,
  initial jsonb not null,
  moves jsonb not null,
  plies integer not null,
  ended_at timestamptz not null default now()
);
create table if not exists tournaments (
  id serial primary key,
  name text not null,
  tc text not null,
  minutes integer not null,
  starts_at timestamptz not null,
  created_by integer references users(id),
  created_at timestamptz not null default now()
);
create table if not exists tournament_players (
  tournament_id integer not null references tournaments(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  score integer not null default 0,
  played integer not null default 0,
  wins integer not null default 0,
  draws integer not null default 0,
  losses integer not null default 0,
  withdrawn boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
alter table games add column if not exists tournament_id integer references tournaments(id);
alter table games add column if not exists seconds integer;
alter table users add column if not exists email_verified_at timestamptz;
update users set email_verified_at = created_at where google_sub is not null and email_verified_at is null;
create index if not exists users_email_idx on users(lower(email));
create table if not exists email_tokens (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists games_red_idx on games(red_id, id desc);
create index if not exists games_blue_idx on games(blue_id, id desc);
`;

async function init() {
  if (pool) await pool.query(SCHEMA);
}

module.exports = {
  enabled: !!pool,
  init,
  query: (text, params) => pool.query(text, params),
  connect: () => pool.connect(),
};
