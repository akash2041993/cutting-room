#!/usr/bin/env python3
"""Tests schema.sql on a real Postgres with a stand-in for Supabase's auth.
Run via tests/db/run.sh. Each case acts as a given database role and user."""
import subprocess, sys

PSQL = ['psql', '-h', '/tmp/pg', '-p', '54329', '-U', 'postgres', '-X', '-q', '-t', '-A', '-d', 'postgres']
A, B, C, D, E, F, G = (f'00000000-0000-0000-0000-0000000000{x}' for x in ('a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'ad'))
fails = 0


def run(sql, role='postgres', uid=None):
    pre = f"set role {role};" + (f"set request.jwt.claim.sub = '{uid}';" if uid else '')
    p = subprocess.run(PSQL + ['-c', pre + sql], capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def T(name, sql, kind='ok', value=None, role='authenticated', uid=None):
    """kind: 'val' stdout equals value | 'err' fails with text containing value | 'ok' succeeds"""
    global fails
    rc, out, err = run(sql, role, uid)
    if kind == 'val':
        good = rc == 0 and out.splitlines()[-1:] == [str(value)]
    elif kind == 'err':
        good = rc != 0 and value.lower() in err.lower()
    else:
        good = rc == 0
    print(('PASS ' if good else 'FAIL ') + name + ('' if good else f'\n   rc={rc} out={out!r} err={err!r} wanted {kind} {value!r}'))
    if not good:
        fails += 1


def count(sql):
    return f'select count(*) from ({sql}) q'


def affected(sql):
    return f'with u as ({sql} returning 1) select count(*) from u'


def review(kind, ident, decision='approved', note=''):
    """The owner (user G) approves or rejects something."""
    rc, out, err = run(f"select admin_review('{kind}','{ident}','{decision}','{note}')", 'authenticated', G)
    assert rc == 0, err


# ---- setup (as the database owner) ----
for uid, email, role in [(A, 'a@x.in', 'editor'), (B, 'b@x.in', 'client'), (C, 'c@x.in', 'editor'),
                         (D, 'd@x.in', 'client'), (E, 'e@x.in', 'editor'), (F, 'f@x.in', 'editor'),
                         (G, 'g@x.in', 'client')]:
    rc, out, err = run(f"insert into auth.users (id,email,raw_user_meta_data) values ('{uid}','{email}', "
                       f"jsonb_build_object('role','{role}','full_name','User {email[0].upper()}','phone','98765 43210'))")
    assert rc == 0, err
T('profiles are created by the sign-up trigger', 'select count(*) from public.profiles', 'val', 7, role='postgres')
T('new profiles start unpaid', 'select count(*) from public.profiles where paid', 'val', 0, role='postgres')
T('role comes from sign-up form', f"select role from public.profiles where id='{A}'", 'val', 'editor', role='postgres')
run("insert into auth.users (id,email) values ('00000000-0000-0000-0000-0000000000a2','plain@x.in')")
T('missing role falls back to client, name from email',
  "select role||'/'||full_name from public.profiles where id='00000000-0000-0000-0000-0000000000a2'", 'val', 'client/plain', role='postgres')
run("insert into auth.users (id,email,raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a3','evil@x.in','{\"role\":\"admin\"}')")
T('unknown role in sign-up data is not accepted',
  "select role from public.profiles where id='00000000-0000-0000-0000-0000000000a3'", 'val', 'client', role='postgres')
rc, _, err = run(f"update public.profiles set paid = true, paid_at = now() where id in ('{A}','{B}','{C}','{F}')", role='service_role')
assert rc == 0, err
T('payment function (service role) can unlock accounts', 'select count(*) from public.profiles where paid', 'val', 4, role='postgres')
# The exact SQL from README.md ("Make that email the owner"), typed with capitals the way a person might, run twice (must not fail)
OWNER_SQL = "insert into public.admins (user_id) select id from auth.users where email = lower('G@X.in') on conflict do nothing; select u.email as owner_email from public.admins a join auth.users u on u.id = a.user_id;"
T('owner setup SQL from the guide works and lists the owner', OWNER_SQL, 'val', 'g@x.in', role='postgres')
T('owner setup SQL can be run twice without an error', OWNER_SQL, 'val', 'g@x.in', role='postgres')
T('owner setup SQL with a wrong email adds nobody', OWNER_SQL.replace('G@X.in', 'nobody@x.in'), 'val', 'g@x.in', role='postgres')
T('exactly one owner exists', 'select count(*) from public.admins', 'val', 1, role='postgres')

# ---- before paying: nothing is visible ----
T('unpaid client sees no editors', count('select * from public.editors'), 'val', 0, uid=D)
T('unpaid client sees no jobs', count('select * from public.jobs'), 'val', 0, uid=D)
T('a client cannot create an editor profile (paid or not)',
  f"insert into public.editors (user_id,name,contact) values ('{D}','D','98765')", 'err', 'row-level security', uid=D)
T('an editor cannot post a job (paid or not)',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Test job','youtube','A brief long enough',1000,'2030-01-01')",
  'err', 'row-level security', uid=E)
T('unpaid user can read the pay-screen numbers', 'select market_counts()::text', 'val', '{"open_jobs" : 0, "editors" : 0}', uid=D)
T('signed-out visitor cannot read editors', 'select count(*) from public.editors', 'err', 'permission denied', role='anon')
T('signed-out visitor cannot call market_counts', 'select market_counts()', 'err', 'permission denied', role='anon')

# ---- editors: creating, approval, editing ----
T('paid editor creates own profile (even if the app claims it is approved)',
  f"insert into public.editors (user_id,name,contact,skills,rate,approval,review_note) "
  f"values ('{A}','Alice Editor','98765 43210','{{youtube,shorts}}',1500,'approved','looks fine')", uid=A)
T('a new profile always starts waiting for review',
  f"select approval||'/'||review_note from public.editors where user_id='{A}'", 'val', 'pending/', role='postgres')
T('editor cannot create a profile for someone else',
  f"insert into public.editors (user_id,name,contact) values ('{C}','Not Carol','98765')", 'err', 'row-level security', uid=A)
T('client cannot create an editor profile',
  f"insert into public.editors (user_id,name,contact) values ('{B}','B','98765')", 'err', 'row-level security', uid=B)
T('paid client does NOT see a profile that is waiting for review', count('select * from public.editors'), 'val', 0, uid=B)
T('the editor sees their own pending profile', count('select * from public.editors'), 'val', 1, uid=A)
T('an editor cannot approve their own profile', f"select admin_review('editor','{A}','approved','')", 'err', 'not allowed', uid=A)
T('a client cannot approve profiles', f"select admin_review('editor','{A}','approved','')", 'err', 'not allowed', uid=B)
T('an editor cannot write the approval column directly', "update public.editors set approval = 'approved'", 'err', 'permission denied', uid=A)
review('editor', A)
T('paid client sees the approved editor', count('select * from public.editors'), 'val', 1, uid=B)
T('unpaid client still sees nothing', count('select * from public.editors'), 'val', 0, uid=D)
T('other editors cannot browse editors', count('select * from public.editors'), 'val', 0, uid=C)
T('editor sees own profile', count('select * from public.editors'), 'val', 1, uid=A)
T('switching "open for work" off keeps the approval', affected("update public.editors set available = false"), 'val', 1, uid=A)
T('...so the client still sees the profile', count('select * from public.editors'), 'val', 1, uid=B)
run("update public.editors set available = true", uid=A, role='authenticated')
T('editing the details sends the profile back for review', affected("update public.editors set rate = 2000"), 'val', 1, uid=A)
T('...so the client no longer sees it', count('select * from public.editors'), 'val', 0, uid=B)
review('editor', A)
T('...until the owner approves it again', count('select * from public.editors'), 'val', 1, uid=B)
T('editor cannot change the owner of a profile', f"update public.editors set user_id = '{C}'", 'err', 'permission denied', uid=A)
run(f"insert into public.editors (user_id,name,contact) values ('{C}','Carol Editor','carol@x.in')", role='postgres')
review('editor', C)
T('editor cannot edit another editor', affected(f"update public.editors set rate = 1 where user_id = '{C}'"), 'val', 0, uid=A)
T('editor cannot delete another editor', affected(f"delete from public.editors where user_id = '{C}'"), 'val', 0, uid=A)
T('updated_at is maintained', f"select updated_at > now() - interval '1 minute' from public.editors where user_id = '{A}'", 'val', 't', role='postgres')

# ---- jobs: posting, approval ----
T('paid client posts a job (owner and approval are forced)',
  f"insert into public.jobs (owner,title,type,brief,budget,deadline,approval,status) "
  f"values ('{C}','Test job','youtube','A brief long enough',1000,'2030-01-01','approved','filled')", uid=B)
T('job owner is the caller, not what was sent', "select owner::text from public.jobs where title = 'Test job'", 'val', B, role='postgres')
T('poster name is filled in', "select poster_name from public.jobs where title = 'Test job'", 'val', 'User B', role='postgres')
T('a new job starts open and waiting for review, whatever the app sent',
  "select status||'/'||approval from public.jobs where title = 'Test job'", 'val', 'open/pending', role='postgres')
T('editor cannot post a job',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Nope','youtube','A brief long enough',1000,'2030-01-01')",
  'err', 'row-level security', uid=A)
T('job with zero budget is rejected',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Free','youtube','A brief long enough',0,'2030-01-01')",
  'err', 'check constraint', uid=B)
JOB = run("select id from public.jobs where title = 'Test job'", role='postgres')[1]
assert len(JOB) == 36, 'could not find the test job'
T('editor does NOT see a job that is waiting for review', count('select * from public.jobs'), 'val', 0, uid=A)
T('the client sees their own pending job', count('select * from public.jobs'), 'val', 1, uid=B)
T('editor cannot apply to a job that is waiting for review',
  f"insert into public.applications (job_id,message,quote) values ('{JOB}','I can do this',1500)", 'err', 'row-level security', uid=A)
T('owner cannot approve their own job', "update public.jobs set approval = 'approved'", 'err', 'permission denied', uid=B)
T('a client cannot use the review function', f"select admin_review('job','{JOB}','approved','')", 'err', 'not allowed', uid=B)
review('job', JOB)
T('paid editor sees the approved open job', count('select * from public.jobs'), 'val', 1, uid=A)
T('unpaid editor sees no jobs', count('select * from public.jobs'), 'val', 0, uid=E)
T('unpaid client sees no jobs', count('select * from public.jobs'), 'val', 0, uid=D)
T('owner sees own job', count('select * from public.jobs'), 'val', 1, uid=B)
T('editor cannot change a job', affected("update public.jobs set title = 'Hacked'"), 'val', 0, uid=A)
T('editor cannot delete a job', affected('delete from public.jobs'), 'val', 0, uid=A)
T('owner cannot hand the job to someone else', f"update public.jobs set owner = '{C}'", 'err', 'permission denied', uid=B)

# a second job, which the owner rejects
T('client posts a second job',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Second job','shorts','Another brief long enough',900,'2030-02-01')", uid=B)
JOB2 = run("select id from public.jobs where title = 'Second job'", role='postgres')[1]
assert len(JOB2) == 36
review('job', JOB2, 'rejected', 'Budget looks unrealistic')
T('the owner of a rejected job sees the reason',
  f"select approval||': '||review_note from public.jobs where id = '{JOB2}'", 'val', 'rejected: Budget looks unrealistic', uid=B)
T('editors do not see a rejected job', count("select * from public.jobs where title = 'Second job'"), 'val', 0, uid=A)
T('fixing a rejected job sends it back for review',
  affected(f"update public.jobs set budget = 5000 where id = '{JOB2}'"), 'val', 1, uid=B)
T('...and clears the old reason', f"select approval||':'||review_note from public.jobs where id = '{JOB2}'", 'val', 'pending:', uid=B)

# ---- applications ----
T('editor applies', f"insert into public.applications (job_id,message,quote) values ('{JOB}','I can do this',1500)", uid=A)
T('applying twice is blocked', f"insert into public.applications (job_id,message,quote) values ('{JOB}','Again please',1500)",
  'err', 'duplicate key', uid=A)
T('second editor applies', f"insert into public.applications (job_id,message,quote) values ('{JOB}','Me too please',1200)", uid=C)
T('client cannot apply',
  f"insert into public.applications (job_id,editor_id,message,quote) values ('{JOB}','{B}','client apply',100)",
  'err', 'row-level security', uid=B)
T('unpaid editor cannot apply',
  f"insert into public.applications (job_id,editor_id,message,quote) values ('{JOB}','{E}','sneaky apply',100)",
  'err', 'row-level security', uid=E)
T('editor cannot apply in someone elses name',
  f"insert into public.applications (job_id,editor_id,message,quote) values ('{JOB}','{C}','spoofed apply',100)",
  'err', 'row-level security', uid=F)
T('application to a job that does not exist is rejected',
  f"insert into public.applications (job_id,editor_id,message,quote) values (gen_random_uuid(),'{F}','ghost job',100)",
  'err', 'row-level security', uid=F)
T('editor sees only own application', count('select * from public.applications'), 'val', 1, uid=A)
T('job owner sees all applications', count('select * from public.applications'), 'val', 2, uid=B)
T('other client sees none', count('select * from public.applications'), 'val', 0, uid=D)
T('editor cannot change own application status', affected("update public.applications set status = 'hired'"), 'val', 0, uid=A)
T('owner shortlists', affected(f"update public.applications set status = 'shortlisted' where editor_id = '{A}'"), 'val', 1, uid=B)
T('owner cannot rewrite an applicants message', "update public.applications set message = 'edited'", 'err', 'permission denied', uid=B)
T('owner hires and fills the job',
  f"with a as (update public.applications set status = 'hired' where editor_id = '{A}' returning 1), "
  f"j as (update public.jobs set status = 'filled', hired = '{A}' where id = '{JOB}' returning 1) "
  f"select (select count(*) from a) + (select count(*) from j)", 'val', 2, uid=B)
T('filling a job keeps it approved', f"select approval from public.jobs where id = '{JOB}'", 'val', 'approved', role='postgres')
T('hired editor still sees the filled job', count(f"select * from public.jobs where id = '{JOB}'"), 'val', 1, uid=A)
T('applicant still sees the filled job', count(f"select * from public.jobs where id = '{JOB}'"), 'val', 1, uid=C)
T('editor who never applied does not see a filled job', count('select * from public.jobs'), 'val', 0, uid=F)
T('new editor creates a profile', f"insert into public.editors (user_id,name,contact) values ('{F}','Fay Editor','fay@x.in')", uid=F)
T('pay-screen numbers do not count anything waiting for review', 'select market_counts()::text', 'val', '{"open_jobs" : 0, "editors" : 2}', uid=D)

# ---- the owner's review desk ----
T('a member cannot open the review queue', "select admin_queue('pending')", 'err', 'not allowed', uid=B)
T('a signed-out visitor cannot open the review queue', "select admin_queue('pending')", 'err', 'permission denied', role='anon')
T('a member is not an admin', 'select is_admin()', 'val', 'f', uid=B)
T('the owner is an admin', 'select is_admin()', 'val', 't', uid=G)
T('nobody can read the admins table from the app', 'select count(*) from public.admins', 'err', 'permission denied', uid=G)
T('nobody can make themselves an admin', f"insert into public.admins (user_id) values ('{B}')", 'err', 'permission denied', uid=B)
T('the queue lists the job waiting for review',
  "select json_array_length(admin_queue('pending')->'jobs')", 'val', 1, uid=G)
T('...with who posted it and how to reach them',
  "select (admin_queue('pending')::jsonb)->'jobs'->0->>'owner_email' || ' | ' || ((admin_queue('pending')::jsonb)->'jobs'->0->>'owner_phone')",
  'val', 'b@x.in | 98765 43210', uid=G)
T('the queue lists the profile waiting for review',
  "select (admin_queue('pending')::jsonb)->'editors'->0->>'name'", 'val', 'Fay Editor', uid=G)
T('the queue can show approved items too', "select json_array_length(admin_queue('approved')->'editors')", 'val', 2, uid=G)
T('headline numbers add up',
  "select (s->>'members') || '/' || (s->>'paid') || '/' || (s->>'pending_jobs') || '/' || (s->>'pending_editors') || '/' || (s->>'live_editors') "
  "from (select (admin_queue('pending')::jsonb)->'stats' as s) q", 'val', '9/4/1/1/2', uid=G)
T('service role records a payment', f"insert into public.payments (payment_id,user_id,email,amount) values ('pay_1','{A}','a@x.in',50000)", role='service_role')
T('...and the owner sees it as revenue', "select (admin_queue('pending')::jsonb)->'stats'->>'revenue'", 'val', '50000', uid=G)
T('a bad decision is refused', f"select admin_review('job','{JOB2}','maybe','')", 'err', 'bad decision', uid=G)
T('an unknown item is reported', "select admin_review('job',gen_random_uuid(),'approved','')", 'err', 'not found', uid=G)
T('an unknown kind is refused', f"select admin_review('user','{JOB2}','approved','')", 'err', 'bad kind', uid=G)

review('job', JOB2)
T('pay-screen numbers count an approved open job', 'select market_counts()::text', 'val', '{"open_jobs" : 1, "editors" : 2}', uid=D)
T('editor whose profile is still in review cannot apply',
  f"insert into public.applications (job_id,message,quote) values ('{JOB2}','Please pick me',900)", 'err', 'row-level security', uid=F)
review('editor', F)
T('pay-screen numbers count the newly approved profile', 'select market_counts()::text', 'val', '{"open_jobs" : 1, "editors" : 3}', uid=D)
T('...once approved the editor can apply', f"insert into public.applications (job_id,message,quote) values ('{JOB2}','Please pick me',900)", uid=F)
T('nobody can apply to a filled job',
  f"insert into public.applications (job_id,message,quote) values ('{JOB}','too late now',100)", 'err', 'row-level security', uid=F)
review('editor', C, 'rejected', 'Portfolio link does not work')
T('a profile the owner rejects disappears for clients', count('select * from public.editors'), 'val', 2, uid=B)
T('the editor sees why', f"select approval||': '||review_note from public.editors where user_id = '{C}'", 'val', 'rejected: Portfolio link does not work', uid=C)
T('a rejected editor cannot apply to new jobs',
  f"insert into public.applications (job_id,message,quote) values ('{JOB2}','Let me in',900)", 'err', 'row-level security', uid=C)
review('job', JOB2, 'rejected', 'Looks fake')
T('the owner can pull an approved job back down', count("select * from public.jobs where title = 'Second job'"), 'val', 0, uid=F)
T('...and the client still sees it with the reason', f"select review_note from public.jobs where id = '{JOB2}'", 'val', 'Looks fake', uid=B)


# ---- the order of things: post first, owner approves, pay last ----
T('an unpaid editor can submit a profile',
  f"insert into public.editors (user_id,name,contact,skills,rate,rate_unit,portfolio) values ('{E}','Eve Editor','eve@x.in','{{youtube}}',60,'min','https://youtube.com/@eve')", uid=E)
T('...it waits for review', f"select approval from public.editors where user_id='{E}'", 'val', 'pending', role='postgres')
T('...and she is told it is under review', f"select count(*) from public.notifications where user_id='{E}' and kind='review'", 'val', 1, role='postgres')
T('an unpaid editor sees their own submission', count('select * from public.editors'), 'val', 1, uid=E)
T('an unpaid editor still sees no jobs', count('select * from public.jobs'), 'val', 0, uid=E)
T('an unpaid client can post a job',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Dees job','brand','Ad film edit, 30 seconds',2000,'2030-03-01')", uid=D)
T('...they are told it is under review', f"select count(*) from public.notifications where user_id='{D}' and kind='review'", 'val', 1, role='postgres')
T('an unpaid client sees their own job', count('select * from public.jobs'), 'val', 1, uid=D)
T('an unpaid client still sees no editors', count('select * from public.editors'), 'val', 0, uid=D)
T('an unpaid person can still edit their pending submission',
  affected("update public.jobs set budget = 2500"), 'val', 1, uid=D)
DJOB = run("select id from public.jobs where title = 'Dees job'", role='postgres')[1]
assert len(DJOB) == 36
review('editor', E)
review('job', DJOB)
review('job', JOB2)
T('approval tells an unpaid person to pay',
  f"select count(*) from public.notifications where user_id in ('{E}','{D}') and kind='approved'", 'val', 2, role='postgres')
T('an approved but unpaid editor is not shown to clients', count("select * from public.editors where name = 'Eve Editor'"), 'val', 0, uid=B)
T('an approved but unpaid client job is not shown to editors', count("select * from public.jobs where title = 'Dees job'"), 'val', 0, uid=A)
T('an approved but unpaid editor cannot apply',
  f"insert into public.applications (job_id,message,quote) values ('{JOB2}','Pick me please',900)", 'err', 'row-level security', uid=E)
T('the pay-screen numbers leave out members who have not paid', 'select market_counts()::text', 'val', '{"open_jobs" : 1, "editors" : 2}', uid=D)
T('the owner is told who is waiting to pay',
  "select (admin_queue('pending')::jsonb)->'stats'->>'awaiting_payment'", 'val', 2, uid=G)
T('live numbers only count paid authors',
  "select (s->>'live_jobs') || '/' || (s->>'live_editors') from (select (admin_queue('pending')::jsonb)->'stats' as s) q", 'val', '1/2', uid=G)

rc, _, err = run(f"update public.profiles set paid = true, paid_at = now() where id in ('{D}','{E}')", role='service_role')
assert rc == 0, err
T('paying tells them', f"select count(*) from public.notifications where user_id in ('{E}','{D}') and kind='paid'", 'val', 2, role='postgres')
T('once the client has paid, editors can see the approved job', count("select * from public.jobs where title = 'Dees job'"), 'val', 1, uid=A)
T('once the editor has paid, clients can see the approved profile', count("select * from public.editors where name = 'Eve Editor'"), 'val', 1, uid=B)
T('the pay-screen numbers now include them', 'select market_counts()::text', 'val', '{"open_jobs" : 2, "editors" : 3}', uid=E)
T('a paid client can browse the editors', count('select * from public.editors'), 'val', 3, uid=D)
T('a paid, approved editor can apply', f"insert into public.applications (job_id,message,quote) values ('{JOB2}','Pick me please',900)", uid=E)
T('an editor still cannot see other editors', count('select * from public.editors'), 'val', 1, uid=E)
T('a client still cannot see other clients jobs', count("select * from public.jobs where title = 'Dees job'"), 'val', 0, uid=B)

# notifications
T('a person reads only their own notifications', 'select count(*) from public.notifications', 'val', 3, uid=E)
T('...they can mark them read', affected('update public.notifications set read = true'), 'val', 3, uid=E)
T('...but cannot write one', f"insert into public.notifications (user_id,title) values ('{E}','You won')", 'err', 'permission denied', uid=E)
T('...or rewrite one', "update public.notifications set title = 'x'", 'err', 'permission denied', uid=E)
T('...or call the function that writes them', f"select notify('{E}','info','x','y')", 'err', 'permission denied', uid=E)
T('a signed-out visitor cannot read notifications', 'select count(*) from public.notifications', 'err', 'permission denied', role='anon')
T('a rejection tells the person why',
  f"select body like '%Portfolio link does not work%' from public.notifications where user_id='{C}' and kind='rejected'", 'val', 't', role='postgres')
T('editing an approved post tells the person it is under review again',
  f"select count(*) from public.notifications where user_id='{A}' and title like '%under review again%'", 'val', 1, role='postgres')

# spam cap: only a few posts may wait for review at once
for i in range(5):
    T(f'a client can have several jobs waiting ({i + 1} of 5)',
      f"insert into public.jobs (title,type,brief,budget,deadline) values ('Spam {i}','youtube','A brief long enough',100,'2030-01-01')", uid=D)
T('...but not a flood of them',
  "insert into public.jobs (title,type,brief,budget,deadline) values ('Spam 5','youtube','A brief long enough',100,'2030-01-01')",
  'err', 'too many posts waiting', uid=D)

# ---- profiles and payment records ----
T('person sees only their own profile', 'select count(*) from public.profiles', 'val', 1, uid=A)
T('person can edit their own name', affected("update public.profiles set full_name = 'Alice New'"), 'val', 1, uid=A)
T('person cannot mark themselves paid', "update public.profiles set paid = true", 'err', 'permission denied', uid=E)
T('person cannot change their role', "update public.profiles set role = 'client'", 'err', 'permission denied', uid=A)
T('person cannot create a profile directly', f"insert into public.profiles (id,role,full_name) values (gen_random_uuid(),'client','x')", 'err', 'permission denied', uid=A)
T('payment tables are private', 'select count(*) from public.payments', 'err', 'permission denied', uid=A)
T('payment link table is private', 'select count(*) from public.payment_links', 'err', 'permission denied', uid=A)

# ---- account deletion ----
T('person can delete their own account', 'select delete_my_account()', uid=A)
T('their profile is gone', f"select count(*) from public.profiles where id = '{A}'", 'val', 0, role='postgres')
T('their editor profile is gone', f"select count(*) from public.editors where user_id = '{A}'", 'val', 0, role='postgres')
T('their applications are gone', f"select count(*) from public.applications where editor_id = '{A}'", 'val', 0, role='postgres')
T('the payment record is kept for accounts', "select count(*) from public.payments where payment_id = 'pay_1' and user_id is null", 'val', 1, role='postgres')
T('a signed-out visitor cannot delete accounts', 'select delete_my_account()', 'err', 'permission denied', role='anon')
T('deleting a client removes their jobs', 'select delete_my_account()', uid=B)
T('deleting another client removes theirs too', 'select delete_my_account()', uid=D)
T('jobs are gone with their owners', "select count(*) from public.jobs", 'val', 0, role='postgres')
T('notifications go with the account', f"select count(*) from public.notifications where user_id in ('{A}','{B}','{D}')", 'val', 0, role='postgres')
T('deleting the owner account removes the admin row', 'select delete_my_account()', uid=G)
T('no admins are left', 'select count(*) from public.admins', 'val', 0, role='postgres')

print('\n' + (f'{fails} FAILED' if fails else 'ALL PASSED'))
sys.exit(1 if fails else 0)
