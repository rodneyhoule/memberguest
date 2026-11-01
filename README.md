# Member/Guest Volunteer Sign-Up

A simple, phone-friendly page where volunteers pick their own shifts.
The page is hosted free on GitHub Pages; sign-ups are stored in a free Supabase database.

Live site: https://rodneyhoule.github.io/memberguest/

> This site is member-run. It is not an official Awbrey Glen Golf Club website.

## Files

| File | What it is |
|---|---|
| `shifts.json` | **Edit this each year.** Event dates, days, roles, shift times, number of spots, disclaimer wording, contacts. |
| `config.js` | Supabase project URL and public key. Leave empty for demo mode. |
| `index.html`, `styles.css`, `app.js` | The sign-up page. |
| `supabase/schema.sql` | Database tables and functions. Run once in Supabase. |
| `supabase/seed.sql` | The shift list for the database, generated from `shifts.json`. |
| `scripts/make_seed.py` | Regenerates `supabase/seed.sql`. |
| `.github/workflows/keepalive.yml` | Daily ping so Supabase doesn't pause the free project. |

## Try it locally (demo mode)

```bash
cd ~/memberguest && python3 -m http.server 8000
```

Open http://localhost:8000. With `config.js` empty, sign-ups are saved only in your browser.

## Setting up Supabase

1. Create a free project at https://supabase.com. Any region in the US West works; save the database password somewhere safe.
2. In the project, open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open another new query, paste `supabase/seed.sql`, and click **Run**. This loads the 42 shifts.
4. Go to **Project Settings → API** (or **API Keys**) and copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **publishable** key (or the legacy **anon public** key). Never use the secret / service_role key.
5. Put both into `config.js`, then commit and push. The "Demo mode" banner disappears.

The public key is safe to publish. The tables are locked, and the key can only call the sign-up
functions, which never return emails or phone numbers.

## Keeping the database awake

Supabase pauses free projects after about 7 days without activity. The **Keep Supabase awake**
GitHub Action runs every day and makes one small read query. It also re-enables itself, because
GitHub turns off scheduled workflows in repositories with no activity for 60 days.

To check it: the repo's **Actions** tab → **Keep Supabase awake** → **Run workflow**.
GitHub emails you if a run fails.

## For the coordinator

- **See who signed up:** Supabase dashboard → **Table Editor** → `roster` (active sign-ups with
  names, phone numbers and emails). Use **Export → CSV** to print or share it.
- **All history:** the `signups` table. Cancelled shifts stay with status `cancelled`.
- **Remove or move someone:** edit their row in `signups` (set `status` to `cancelled`, or change `shift_id`).

## Changing the shifts

1. Edit `shifts.json` (times, spots, new roles). Don't rename a shift `id` once people have signed up for it.
2. Run `python3 scripts/make_seed.py > supabase/seed.sql`, then run `seed.sql` in the Supabase SQL Editor.
3. Commit and push.

## Privacy

The public page shows first name and last initial only. Emails and phone numbers are visible only in
the Supabase dashboard. "Look up my shifts" works with either the email or the phone number used to sign up, so anyone who knows one of those can see and cancel that person's shifts. Cancelled rows stay in the database and can be restored.
