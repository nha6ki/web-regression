# Web regression tests for Gitea and Vikunja

This Playwright suite tests whether Japanese issue and task data survives a round trip through a web application. It creates records in Chromium, reads them back by ID through the application API, and checks their contents. Two additional Gitea scenarios cover search after a title edit and access to an issue in a private repository.

## Run the suite

On Windows, enable Docker Desktop's WSL integration for your Ubuntu distribution. From the repository root in WSL, run:

```bash
bash run.sh
```

The first run downloads the container images. Each run installs the pinned Playwright test package inside the test container, which supplies Node.js and Chromium. A successful run ends with **4 passed**. Open the HTML report at the path printed by the script, under `reports/<timestamp>-<pid>/html/index.html`. Failed browser tests also capture a screenshot.

## What the four tests check

| Scenario | Action | Evidence checked |
| --- | --- | --- |
| [Gitea issue creation](tests/gitea.spec.ts) | Submit a Japanese title and body through the issue form. | Use the issue number from the resulting page URL to fetch the record. The API must return the same title and body with state `open`. |
| [Gitea issue lifecycle](tests/gitea-lifecycle.spec.ts) | Rename an issue through the API, load the issue list with the new title as the search query, and open the matching result. | The unrelated issue is absent from the results. The selected link opens the original issue number. After closing it through the API, a fresh read returns `closed`. |
| [Gitea private issue visibility](tests/gitea-visibility.spec.ts) | Request the same issue as a read collaborator and as a signed-in nonmember, through both the UI and API. | The collaborator sees the title and body. The nonmember receives HTTP 403 or 404, and both strings are absent from the API response and rendered page. |
| [Vikunja task creation](tests/vikunja.spec.ts) | Create a task titled `月次報告の資料を確認` in the project view and confirm it appears on screen. | Fetch the task by the ID returned by the create request. The API must return the submitted title, the expected project ID, and `done: false`. |

## Test environment

[Docker Compose](compose.yaml) starts Gitea 1.27.3 with SQLite and Vikunja 0.24.6 with PostgreSQL 16. The test container reaches both applications over the Compose network without publishing host ports. Each run gets a separate Compose project and a generated password. On exit, the runner removes that project's containers and volumes. Reports remain on the host.

Both applications use the same [Playwright configuration](playwright.config.ts) and HTML reporter. The suite runs with one worker and zero test retries. The [GitHub Actions workflow](.github/workflows/regression.yml) calls the same `bash run.sh` entry point on Ubuntu for pushes, pull requests, and manual runs. After a completed test run, the workflow uploads the HTML report, including when a test fails. Artifact retention is set to 14 days.

## CI evidence

The failure drill changed only the expected Vikunja title on a dedicated branch. The browser still submitted `月次報告の資料を確認`, while the API assertion expected `請求書を照合`. The failure report recorded both values. Reverting the assertion restored the baseline.

| GitHub Actions run | Commit | Verified result |
| --- | --- | --- |
| [Baseline](https://github.com/nha6ki/web-regression/actions/runs/45025068822) | `c06a2ee` | All four tests passed. |
| [Title mismatch](https://github.com/nha6ki/web-regression/actions/runs/45026775483) | `c1c92d3` | Only the Vikunja test failed. All three Gitea tests passed, and the failure report was saved. |
| [After revert](https://github.com/nha6ki/web-regression/actions/runs/45026915548) | `4d68215` | All four tests passed again, and the recovery report was saved. |
