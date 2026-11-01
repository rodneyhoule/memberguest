# Member/Guest Volunteer Sign-Up

A simple, phone-friendly page where volunteers pick their own shifts. The page is hosted
free on GitHub Pages, and sign-ups are saved to a Google Sheet that the coordinators can open,
edit and print.

> This site is member-run. It is not an official Awbrey Glen Golf Club website.

## Files

| File | What it is |
|---|---|
| `shifts.json` | **Edit this each year.** Event dates, days, roles, shift times, number of spots, disclaimer wording, contacts. |
| `config.js` | The Google Apps Script URL. Leave it empty for demo mode. |
| `index.html`, `styles.css`, `app.js` | The sign-up page. |
| `apps-script/Code.gs` | The backend code that goes in the Google Sheet. |

## Try it locally (demo mode)

```bash
cd ~/memberguest && python3 -m http.server 8000
```

Open http://localhost:8000. With `config.js` empty, sign-ups are saved only in your browser.

## Going live

### 1. Put the site on GitHub Pages
1. Create a GitHub repository (for example `memberguest`) and push these files to it.
2. Go to the repo's **Settings → Pages**, set **Source** to "Deploy from a branch", choose `main` / root, and save.
3. Your site will be at `https://YOURNAME.github.io/memberguest/`.

### 2. Create the Google Sheet backend
1. Create a new Google Sheet (for example "MMG Volunteers") using the Google account that should
   send the confirmation emails.
2. Go to **Extensions → Apps Script**, delete the sample code and paste in `apps-script/Code.gs`.
3. Change `SITE_URL` at the top to your GitHub Pages address (keep the trailing `/`).
4. Click **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Approve the permissions (Sheets, sending email, fetching the shift list).
6. Copy the web app URL (it ends in `/exec`).

### 3. Connect them
Paste the `/exec` URL into `config.js`, then commit and push. The "Demo mode" banner disappears.

### 4. Test before announcing
Sign up from your phone with a test name, check the email and the "change my shifts" link, and cancel a shift.
Then delete the test rows from the **Signups** tab.

## For the coordinator

- **Signups tab:** one row per person per shift. Cancelled shifts stay in the sheet marked `Cancelled`.
  To move someone, change the Shift ID or Status in the sheet.
- **Volunteers → Build printable roster** (menu in the Sheet): creates a **Roster** tab laid out like
  the old printed list, with names and phone numbers and "OPEN" for empty spots.
- **Changing shifts:** edit `shifts.json` and push. The backend picks up changes within 10 minutes.
  Don't rename a shift `id` once people have signed up for it.
- **Updating Code.gs:** after editing, use **Deploy → Manage deployments → Edit → New version** so the
  URL stays the same.

## Privacy

The public page shows first name and last initial only. Emails and phone numbers are stored only in
the Google Sheet. Coordinator phone numbers appear on the page only if they're added to `contacts`
in `shifts.json`.
