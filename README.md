# Karvishit Services PRV LTD

## Run with Express

1. Install Node.js 18 or newer.
2. In this folder, run `npm install`.
3. Stop the PowerShell preview if it is using port 3000. Set an admin password, then run `npm start`.
4. Open <http://localhost:3000>.

PowerShell example:

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = 'use-a-long-unique-password'
npm start
```

Open <http://localhost:3000/admin> and enter those credentials when prompted. Use HTTPS when exposing the admin page beyond your local development machine because HTTP Basic credentials are not encrypted over plain HTTP.

The contact form validates in the browser and posts to `/api/contact`. Submissions are appended to `data/contacts.jsonl` by default. The `data` folder is excluded from Git because it contains contact details.

Career openings can be created and removed in the protected admin page. They are stored in `data/jobs.json` by default and listed publicly under Careers. Set `MONGODB_URI` to store contacts and job openings in MongoDB instead.

## Optional MongoDB

Set `MONGODB_URI` before starting the server to store submissions and job openings in MongoDB instead. The database name defaults to `karvishit`; override it with `MONGODB_DB`.

PowerShell example:

```powershell
$env:MONGODB_URI = 'mongodb://localhost:27017'
$env:MONGODB_DB = 'karvishit'
npm start
```

The health endpoint is available at `/api/health`.
