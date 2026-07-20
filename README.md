# Wikimedia Sightglass

A web app for viewing and analyzing [mediacounts](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Traffic/Mediacounts) statistics for media files on Wikimedia Commons.

Queries can be run on individual files or category trees. Queries are run server-side and results are stored so users can save, revisit, and share them. Users must log in via Wikimedia to run queries, for the sake of managing load and being able to save results.

## Data

This application uses the [mediacounts](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Traffic/Mediacounts) dataset, which stores counts of how often media files from upload.wikimedia.org have been transferred to users. It also pulls and displays usage of files across Wikimedia wikis.

## Setup

### Prerequisites

- Node.js
- Wikimedia OAuth credentials

### Getting OAuth Credentials

1. Go to [Wikimedia OAuth Consumer Registration](https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose)
2. Select **OAuth 1.0a**
3. Fill in your application details:
   - **Application name**: Your application name
   - **OAuth "callback" URL**: Your app's callback URL, e.g. `http://localhost:3000/auth/callback`
   - **Applicable grants**: Select "User identity verification only"
4. Submit (approval should be instant given no permissions)

### Installation

```bash
npm install
cp .env.sample .env
```

Edit `.env` with your configuration.

## Running

Development mode (with auto-reload):

```bash
npm run dev
```

Production mode:

```bash
npm start
```

The server will run on `http://localhost:3000`

## API Endpoints

Endpoints are authenticated (except where noted) to manage load and avoid abusive scrapers.

### Get Media Statistics

```
GET /api/media/stats
```

Parameters:

- `filename` (required) - Commons filename
- `start` (optional) - Start date in YYYYMMDD format (default: 32 days ago)
- `end` (optional) - End date in YYYYMMDD format (default: 2 days ago, since mediacounts data may lag)
- `granularity` (optional) - `daily` or `monthly` (default: daily)
- `referer` (optional) - Referer filter (default: all-referers)
- `agent` (optional) - Agent type filter (default: all-agents)

### Get Category Statistics

```
POST /api/category/stats
```

JSON body fields:

- `category` (required) - Category name
- `start` (optional) - Start date in YYYYMMDD format
- `end` (optional) - End date in YYYYMMDD format
- `granularity` (optional) - `daily` or `monthly` (default: daily)
- `depth` (optional) - Subcategory depth 0-10 (default: 0)
- `referer` (optional) - Referer filter
- `agent` (optional) - Agent type filter

Always runs asynchronously and returns a job reference immediately:

```json
{
  "jobId": "abc123...",
  "status": "pending",
  "statusUrl": "/api/jobs/abc123..."
}
```

### Get Job Status

```
GET /api/jobs/:jobId
```

**Authentication**: Not required (permalink is shareable)

Returns job status, progress, and results when complete.

### List User's Jobs

```
GET /api/jobs
```

Parameters:

- `limit` (optional) - Number of jobs to return (default: 50, max: 100)

The response includes an `X-Total-Count` header with the user's total job
count, so clients can tell when the list is truncated.

### Search Commons Files

```
GET /api/media/search
```

Parameters:

- `query` (required) - Search term
- `limit` (optional) - Number of results (default: 10, max: 50)

### Get Category Files

```
GET /api/category/files
```

Parameters:

- `category` (required) - Category name
- `depth` (optional) - Subcategory depth 0-10 (default: 0)

### Lifetime Statistics

```
GET /api/stats
```

**Authentication**: Not required (shown on the public `/stats` page)

Returns lifetime totals: queries completed, files analyzed, views counted,
distinct categories queried, categories scanned (subcategories included),
processing time, single-file lookups, and users served. These counters
persist after old jobs are deleted.

### Session Status

```
GET /api/session
```

Returns authentication status and user information.

### Authentication Routes

- `GET /login` - Initiate OAuth login flow
- `GET /auth/callback` - OAuth callback handler
- `POST /logout` - Logout and clear session

## Rate Limiting

API endpoints are rate-limited per authenticated user to 500 requests per minute.

Outbound Wikimedia API traffic is throttled by a global scheduler (one
request per 100ms process-wide). Jobs run concurrently (up to
`MAX_CONCURRENT_JOBS`) and take turns round-robin, so short jobs finish
quickly while long ones run, and total upstream load never grows with the
number of jobs. A 429 from Wikimedia pauses all outbound traffic for the
requested interval.
