-- =====================================================================
--  Cutting Room: database tables and security rules
--
--  How to run: Supabase dashboard -> SQL Editor -> New query -> paste
--  this whole file -> Run. It is safe to run again later; it never
--  deletes your data.
--
--  The important part is at the bottom: row level security. Until a
--  person's account is marked paid, the database itself refuses to show
--  them jobs, editors or contact details. The app cannot get around it.
--
--  How a person gets in:
--    1. They sign up and submit their post: an editor profile, or a job.
--    2. The post waits as "pending". Only its author can see it. They are
--       told it is under review.
--    3. The owner (an "admin") approves or rejects it. A rejection comes with
--       a reason, and the person can fix it and send it again.
--    4. When approved, the person is told to pay the one-time fee.
--    5. Once they have paid, their post is shown to the other side (jobs to
--       editors, editors to clients) and they can see the other side's posts.
--  To become the owner, run the one line at the very bottom of this file.
-- =====================================================================

-- ---------- tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('editor', 'client')),
  full_name   text not null check (char_length(full_name) between 1 and 60),
  phone       text check (phone is null or char_length(phone) <= 30),
  paid        boolean not null default false,
  paid_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.editors (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  headline    text not null default '' check (char_length(headline) <= 90),
  city        text not null default '' check (char_length(city) <= 50),
  about       text not null default '' check (char_length(about) <= 1200),
  skills      text[] not null default '{}',
  tools       text[] not null default '{}',
  rate        integer not null default 0 check (rate >= 0),
  rate_unit   text not null default 'video' check (rate_unit in ('video', 'min', 'hour', 'month')),
  portfolio   text not null default '' check (char_length(portfolio) <= 200),
  contact     text not null check (char_length(contact) between 3 and 80),
  available   boolean not null default true,
  approval    text not null default 'pending' check (approval in ('pending', 'approved', 'rejected')),
  review_note text not null default '' check (char_length(review_note) <= 300),
  reviewed_at timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  poster_name text not null default '',
  title       text not null check (char_length(title) between 3 and 100),
  type        text not null check (type in ('youtube', 'shorts', 'podcast', 'wedding', 'brand', 'news', 'motion')),
  brief       text not null check (char_length(brief) between 10 and 2000),
  budget      integer not null check (budget > 0),
  unit        text not null default 'project' check (unit in ('video', 'project', 'month')),
  deadline    date not null,
  length      text not null default '' check (char_length(length) <= 60),
  tools       text[] not null default '{}',
  status      text not null default 'open' check (status in ('open', 'filled', 'closed')),
  hired       uuid references public.profiles (id) on delete set null,
  approval    text not null default 'pending' check (approval in ('pending', 'approved', 'rejected')),
  review_note text not null default '' check (char_length(review_note) <= 300),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.applications (
  job_id      uuid not null references public.jobs (id) on delete cascade,
  editor_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  message     text not null check (char_length(message) between 5 and 600),
  quote       integer not null check (quote > 0),
  status      text not null default 'new' check (status in ('new', 'shortlisted', 'hired', 'declined')),
  created_at  timestamptz not null default now(),
  primary key (job_id, editor_id)
);

-- The owner(s). Nobody can read or write this table from the app; it is only
-- used by the review functions below. Add yourself with the line at the bottom.
create table if not exists public.admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  added_at    timestamptz not null default now()
);

-- Private bookkeeping. Only the payment function (service role) can touch these.
create table if not exists public.payment_links (
  id          text primary key,                       -- Razorpay link id, plink_...
  user_id     uuid not null references public.profiles (id) on delete cascade,
  short_url   text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.payments (
  payment_id  text primary key,                       -- Razorpay payment id, pay_...
  user_id     uuid references public.profiles (id) on delete set null,
  email       text,
  link_id     text,
  amount      integer not null,                       -- in paise (50000 = 500 rupees)
  created_at  timestamptz not null default now()
);

-- What each person is told in the app: "under review", "approved, pay to go live", and so on.
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null default 'info',
  title       text not null,
  body        text not null default '',
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists jobs_owner_idx on public.jobs (owner);
create index if not exists applications_editor_idx on public.applications (editor_id);

-- ---------- helper functions (they read around row security on purpose) ----------

create or replace function public.is_paid() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select paid from public.profiles where id = auth.uid()), false)
$$;

-- Has this particular person paid? (Used to show a post only once its author has paid.)
create or replace function public.is_paid_user(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select paid from public.profiles where id = u), false)
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.owns_job(j uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs where id = j and owner = auth.uid())
$$;

create or replace function public.applied_to(j uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.applications where job_id = j and editor_id = auth.uid())
$$;

create or replace function public.job_is_open(j uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.jobs
                 where id = j and status = 'open' and approval = 'approved' and owner <> auth.uid()
                   and public.is_paid_user(owner))
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- An editor can only apply once the owner has approved their profile,
-- because the client needs something real to look at.
create or replace function public.has_approved_profile() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.editors where user_id = auth.uid() and approval = 'approved')
$$;

-- Numbers shown on the pay screen, before the person has paid.
create or replace function public.market_counts() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'open_jobs', (select count(*) from public.jobs j join public.profiles p on p.id = j.owner and p.paid
                  where j.status = 'open' and j.approval = 'approved'),
    'editors',   (select count(*) from public.editors e join public.profiles p on p.id = e.user_id and p.paid
                  where e.approval = 'approved')
  )
$$;

-- Lets a person delete their own account and everything attached to it.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Writes a line into one person's notifications. Only the database's own
-- triggers and review functions can call this; the app cannot.
create or replace function public.notify(p_user uuid, p_kind text, p_title text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, title, body)
  values (p_user, p_kind, left(p_title, 120), left(coalesce(p_body, ''), 400))
$$;

-- ---------- the owner's review desk ----------

-- Everything waiting for review (or already approved / rejected), with who
-- posted it and how to reach them, plus the headline numbers.
create or replace function public.admin_queue(p_status text default 'pending') returns json
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'bad status';
  end if;
  return json_build_object(
    'jobs', coalesce((
      select json_agg(x order by x.created_at desc) from (
        select j.*, p.full_name as owner_name, p.phone as owner_phone, p.paid as owner_paid,
               p.created_at as owner_joined, u.email as owner_email
        from public.jobs j
        join public.profiles p on p.id = j.owner
        left join auth.users u on u.id = j.owner
        where j.approval = p_status
        order by j.created_at desc limit 200
      ) x), '[]'::json),
    'editors', coalesce((
      select json_agg(x order by x.updated_at desc) from (
        select e.*, p.full_name as owner_name, p.phone as owner_phone, p.paid as owner_paid,
               p.created_at as owner_joined, u.email as owner_email
        from public.editors e
        join public.profiles p on p.id = e.user_id
        left join auth.users u on u.id = e.user_id
        where e.approval = p_status
        order by e.updated_at desc limit 200
      ) x), '[]'::json),
    'stats', json_build_object(
      'members',         (select count(*) from public.profiles),
      'editor_members',  (select count(*) from public.profiles where role = 'editor'),
      'client_members',  (select count(*) from public.profiles where role = 'client'),
      'paid',            (select count(*) from public.profiles where paid),
      'revenue',         (select coalesce(sum(amount), 0) from public.payments),   -- paise
      'pending_jobs',    (select count(*) from public.jobs where approval = 'pending'),
      'pending_editors', (select count(*) from public.editors where approval = 'pending'),
      'live_jobs',       (select count(*) from public.jobs j join public.profiles p on p.id = j.owner and p.paid
                          where j.approval = 'approved' and j.status = 'open'),
      'live_editors',    (select count(*) from public.editors e join public.profiles p on p.id = e.user_id and p.paid
                          where e.approval = 'approved'),
      'awaiting_payment', (select count(*) from public.profiles p where not p.paid and (
                            exists (select 1 from public.jobs j where j.owner = p.id and j.approval = 'approved')
                            or exists (select 1 from public.editors e where e.user_id = p.id and e.approval = 'approved')))
    )
  );
end $$;

-- Approve or reject one item. kind is 'job' or 'editor'; for an editor the id is the person's id.
create or replace function public.admin_review(p_kind text, p_id uuid, p_decision text, p_note text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid;
  v_label text;
  v_paid  boolean;
  v_note  text := left(coalesce(p_note, ''), 300);
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if p_decision not in ('approved', 'rejected', 'pending') then
    raise exception 'bad decision';
  end if;
  if p_kind = 'job' then
    update public.jobs set approval = p_decision, review_note = v_note, reviewed_at = now()
      where id = p_id returning owner, 'Your job "' || title || '"' into v_user, v_label;
  elsif p_kind = 'editor' then
    update public.editors set approval = p_decision, review_note = v_note, reviewed_at = now()
      where user_id = p_id returning user_id, 'Your editor profile' into v_user, v_label;
  else
    raise exception 'bad kind';
  end if;
  if v_user is null then
    raise exception 'not found';
  end if;
  select paid into v_paid from public.profiles where id = v_user;
  if p_decision = 'approved' then
    if coalesce(v_paid, false) then
      perform public.notify(v_user, 'live', 'Your post is live', v_label || ' is approved and now visible in the app.');
    else
      perform public.notify(v_user, 'approved', 'Approved. Pay once to go live',
        v_label || ' is approved. Pay the one-time fee in the app and it goes live straight away.');
    end if;
  elsif p_decision = 'rejected' then
    perform public.notify(v_user, 'rejected', 'Not approved',
      v_label || ' was not approved.' || case when v_note <> '' then ' ' || v_note else '' end || ' Edit it and send it again.');
  end if;
end $$;

-- ---------- triggers ----------

-- Creates the profile row when someone registers. The role and name come
-- from the sign-up form. "paid" always starts as false.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text := coalesce(new.raw_user_meta_data ->> 'role', '');
begin
  if r not in ('editor', 'client') then
    r := 'client';
  end if;
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    r,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1), 'Member'), 60),
    left(nullif(trim(new.raw_user_meta_data ->> 'phone'), ''), 30)
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A job always belongs to whoever posted it, always starts open, and always
-- waits for the owner's approval, whatever the app sends.
create or replace function public.jobs_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.jobs where owner = auth.uid() and approval = 'pending') >= 5 then
    raise exception 'too many posts waiting for review';
  end if;
  new.owner       := auth.uid();
  new.poster_name := coalesce((select full_name from public.profiles where id = auth.uid()), '');
  new.status      := 'open';
  new.hired       := null;
  new.approval    := 'pending';
  new.review_note := '';
  new.reviewed_at := null;
  new.created_at  := now();
  return new;
end $$;

create or replace function public.jobs_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.owner, 'review', 'Your job is under review',
    'The owner is checking "' || new.title || '". You will be told here as soon as it is approved. You pay nothing until then.');
  return new;
end $$;

drop trigger if exists jobs_after_insert on public.jobs;
create trigger jobs_after_insert
  after insert on public.jobs
  for each row execute function public.jobs_after_insert();

drop trigger if exists jobs_before_insert on public.jobs;
create trigger jobs_before_insert
  before insert on public.jobs
  for each row execute function public.jobs_before_insert();

-- If the owner of a job changes what it says, it goes back for review.
-- Closing it, marking it filled or moving the deadline does not.
create or replace function public.jobs_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.title, new.type, new.brief, new.budget, new.unit, new.length)
     is distinct from (old.title, old.type, old.brief, old.budget, old.unit, old.length) then
    new.approval    := 'pending';
    new.review_note := '';
    new.reviewed_at := null;
    if old.approval <> 'pending' then
      perform public.notify(new.owner, 'review', 'Your job is under review again',
        'You changed "' || new.title || '", so the owner will check it again before it shows.');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists jobs_before_update on public.jobs;
create trigger jobs_before_update
  before update on public.jobs
  for each row execute function public.jobs_before_update();

-- Editor profiles: new ones wait for approval; changing the details sends an
-- approved (or rejected) profile back for review. Only flipping "available" does not.
-- The owner's own approve/reject changes none of these columns, so they stick.
drop trigger if exists editors_touch on public.editors;
drop function if exists public.editors_touch();

create or replace function public.editors_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.approval    := 'pending';
    new.review_note := '';
    new.reviewed_at := null;
    new.updated_at  := now();
  else
    if (new.name, new.headline, new.city, new.about, new.skills, new.tools, new.rate, new.rate_unit, new.portfolio, new.contact)
       is distinct from
       (old.name, old.headline, old.city, old.about, old.skills, old.tools, old.rate, old.rate_unit, old.portfolio, old.contact) then
      new.approval    := 'pending';
      new.review_note := '';
      new.reviewed_at := null;
      if old.approval <> 'pending' then
        perform public.notify(new.user_id, 'review', 'Your profile is under review again',
          'You changed your editor profile, so the owner will check it again before clients see it.');
      end if;
    end if;
    if (new.name, new.headline, new.city, new.about, new.skills, new.tools, new.rate, new.rate_unit, new.portfolio, new.contact, new.available)
       is distinct from
       (old.name, old.headline, old.city, old.about, old.skills, old.tools, old.rate, old.rate_unit, old.portfolio, old.contact, old.available) then
      new.updated_at := now();
    end if;
  end if;
  return new;
end $$;

create or replace function public.editors_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.user_id, 'review', 'Your profile is under review',
    'The owner is checking your editor profile. You will be told here as soon as it is approved. You pay nothing until then.');
  return new;
end $$;

drop trigger if exists editors_after_insert on public.editors;
create trigger editors_after_insert
  after insert on public.editors
  for each row execute function public.editors_after_insert();

-- When the payment function marks someone paid, tell them.
create or replace function public.profiles_after_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.paid and not old.paid then
    perform public.notify(new.id, 'paid', 'Payment received. You are in',
      'Thank you. Your approved posts are now live and you can see the other side of the app.');
  end if;
  return new;
end $$;

drop trigger if exists profiles_after_paid on public.profiles;
create trigger profiles_after_paid
  after update of paid on public.profiles
  for each row execute function public.profiles_after_paid();

drop trigger if exists editors_before_write on public.editors;
create trigger editors_before_write
  before insert or update on public.editors
  for each row execute function public.editors_before_write();

-- ---------- who may do what ----------

alter table public.profiles       enable row level security;
alter table public.editors        enable row level security;
alter table public.jobs           enable row level security;
alter table public.applications   enable row level security;
alter table public.payment_links  enable row level security;
alter table public.payments       enable row level security;
alter table public.admins         enable row level security;
alter table public.notifications  enable row level security;

-- Start from nothing, then grant back only what the app needs.
revoke all on public.profiles, public.editors, public.jobs, public.applications,
              public.payment_links, public.payments, public.admins, public.notifications from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;      -- never "paid" or "role"

grant select, insert, delete on public.editors to authenticated;
grant update (name, headline, city, about, skills, tools, rate, rate_unit, portfolio, contact, available)
  on public.editors to authenticated;

grant select, insert, delete on public.jobs to authenticated;
grant update (title, type, brief, budget, unit, deadline, length, tools, status, hired)
  on public.jobs to authenticated;

grant select, insert, delete on public.applications to authenticated;
grant update (status) on public.applications to authenticated;

grant select on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;     -- they can only mark a line as read

-- Functions: signed-in people only.
revoke all on function public.is_paid(), public.my_role(), public.owns_job(uuid), public.applied_to(uuid),
                       public.job_is_open(uuid), public.market_counts(), public.delete_my_account(),
                       public.is_admin(), public.has_approved_profile(), public.is_paid_user(uuid),
                       public.admin_queue(text), public.admin_review(text, uuid, text, text),
                       public.notify(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.is_paid(), public.my_role(), public.owns_job(uuid), public.applied_to(uuid),
                          public.job_is_open(uuid), public.market_counts(), public.delete_my_account(),
                          public.is_admin(), public.has_approved_profile(), public.is_paid_user(uuid),
                          public.admin_queue(text), public.admin_review(text, uuid, text, text)
  to authenticated;      -- (notify is deliberately not granted to anyone)

-- profiles: you see and edit only your own row.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- editors: an editor can always create, see and edit their own profile (even before paying).
-- A client sees another editor only when the client has paid, the owner approved the
-- profile, and that editor has paid too.
drop policy if exists editors_select on public.editors;
create policy editors_select on public.editors for select to authenticated
  using (
    user_id = auth.uid()
    or (public.is_paid() and public.my_role() = 'client' and approval = 'approved' and public.is_paid_user(user_id))
  );

drop policy if exists editors_insert on public.editors;
create policy editors_insert on public.editors for insert to authenticated
  with check (user_id = auth.uid() and public.my_role() = 'editor');

drop policy if exists editors_update on public.editors;
create policy editors_update on public.editors for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists editors_delete on public.editors;
create policy editors_delete on public.editors for delete to authenticated
  using (user_id = auth.uid());

-- jobs: a client can always create, see and edit their own jobs (even before paying).
-- An editor sees a job only when the editor has paid, the owner approved the job, and the
-- client who posted it has paid too.
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs for select to authenticated
  using (
    owner = auth.uid()
    or (
      public.is_paid() and approval = 'approved' and public.is_paid_user(owner) and (
        (status = 'open' and public.my_role() = 'editor')
        or public.applied_to(id)
      )
    )
  );

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs for insert to authenticated
  with check (public.my_role() = 'client');

drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists jobs_delete on public.jobs;
create policy jobs_delete on public.jobs for delete to authenticated
  using (owner = auth.uid());

-- applications: the editor who sent it and the client who owns the job can see it.
drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications for select to authenticated
  using (public.is_paid() and (editor_id = auth.uid() or public.owns_job(job_id)));

drop policy if exists applications_insert on public.applications;
create policy applications_insert on public.applications for insert to authenticated
  with check (
    editor_id = auth.uid() and public.is_paid() and public.my_role() = 'editor'
    and public.has_approved_profile() and public.job_is_open(job_id)
  );

drop policy if exists applications_update on public.applications;
create policy applications_update on public.applications for update to authenticated
  using (public.is_paid() and public.owns_job(job_id))
  with check (public.owns_job(job_id));

drop policy if exists applications_delete on public.applications;
create policy applications_delete on public.applications for delete to authenticated
  using (editor_id = auth.uid() or public.owns_job(job_id));

-- notifications: you read your own and can mark them read. Nobody can write them from the app.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- payment_links and payments have no policies on purpose: nobody but the
-- server-side payment function (service role) can read or write them.

-- =====================================================================
--  BECOME THE OWNER (run this once, as a separate query)
--
--  1. Open the app and create your own account with the email you want to
--     use as the owner (pick either role; it does not matter).
--  2. Replace the email below with that email and run just this line:
--
--     insert into public.admins (user_id) select id from auth.users where email = lower('you@example.com') on conflict do nothing;
--     select u.email from public.admins a join auth.users u on u.id = a.user_id;   -- lists the owners; yours should appear
--
--  Next time you sign in to the app with that email you land on the Review
--  desk instead of the member screens. You do not pay the 500 rupees.
--  To remove an owner:  delete from public.admins where user_id in (select id from auth.users where email = '...');
-- =====================================================================
