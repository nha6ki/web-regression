# Web regression tests for Gitea, Vikunja, Grist, Paperless-ngx, Snipe-IT WordPress, WooCommerce, Nextcloud and Moodle

This Playwright suite tests whether Japanese issue and task data survives a round trip through a web application. It creates records in Chromium, reads them back by ID through the application API, and checks their contents. Two additional Gitea scenarios cover search after a title edit and access to an issue in a private repository.

## Run the suite

Requirements: Linux or Windows with WSL2, Bash, and a running Docker Engine with the Compose v2 CLI or newer. The runner uses the Linux kernel UUID generator. On Windows, enable Docker Desktop's WSL integration for your Ubuntu distribution. From the repository root in WSL, run:

```bash
bash run.sh
```

The first run downloads the container images. Each run installs the dependencies in `package-lock.json` with `npm ci` inside the test container, which supplies Node.js and Chromium. Host installations of Node.js, npm and browsers are optional. The runner needs access to the image registries and npm registry. A successful run ends with **28 passed**. Open the HTML report at the path printed by the script, under `reports/<timestamp>-<pid>/html/index.html`. Failed browser tests also capture a screenshot.

The runner also uses host curl and unzip to install WooCommerce 11.3.0 from downloads.wordpress.org. Three store tests check cart quantities, saved order lines and product-specific discounts. The fixtures use Japanese yen, virtual products, and an offline payment method.

Moodle uses a separate PostgreSQL database and PHP container. The runner fetches Moodle 4.5.16 from packaging.moodle.org and verifies the archive checksum before installing it. The course has a teacher, two enrolled students and a separate assignment for each case.

## What the twenty-eight tests check

| Scenario | Action | Evidence checked |
| --- | --- | --- |
| Moodle submission | A student uploads a Japanese-named assignment file and submits it. | The teacher retrieves that student's submitted file and compares all bytes. |
| Moodle feedback | The teacher grades a submitted assignment. | The student sees the grade and written feedback on the assignment page. |
| Moodle independent grading | Two students submit to the same assignment. | After grading one student, their grade exists and the other submission remains ungraded. |
| Nextcloud file move | Move a Japanese-named text file to a second folder. | The source returns 404, the destination returns the original bytes, and Files shows the name in the destination folder. |
| Nextcloud trash restore | Delete a file and restore its matching trash entry. | The original path first returns 404 and then returns the original bytes. |
| Nextcloud same-name files | Overwrite one of two files with the same name in separate folders. | Both paths return the expected, distinct contents. |
| [Gitea issue creation](tests/gitea.spec.ts) | Submit a Japanese title and body through the issue form. | Use the issue number from the resulting page URL to fetch the record. The API must return the same title and body with state `open`. |
| [Gitea issue lifecycle](tests/gitea-lifecycle.spec.ts) | Rename an issue through the API, load the issue list with the new title as the search query, and open the matching result. | The unrelated issue is absent from the results. The selected link opens the original issue number. After closing it through the API, a fresh read returns `closed`. |
| [Gitea private issue visibility](tests/gitea-visibility.spec.ts) | Request the same issue as a read collaborator and as a signed-in nonmember, through both the UI and API. | The collaborator sees the title and body. The nonmember receives HTTP 403 or 404, and both strings are absent from the API response and rendered page. |
| [Vikunja task creation](tests/vikunja.spec.ts) | Create a task titled `月次報告の資料を確認` in the project view and confirm it appears on screen. | Fetch the task by the ID returned by the create request. The API must return the submitted title, the expected project ID, and `done: false`. |
| [Vikunja completion](tests/vikunja-workflows.spec.ts) | Complete a task and reload its detail view. | The UI offers to reopen it and its API record is complete. |
| [Vikunja empty title](tests/vikunja-workflows.spec.ts) | Press Enter in an empty task field. | The project keeps exactly the original task IDs. |
| [Vikunja same-title tasks](tests/vikunja-workflows.spec.ts) | Complete one of two identically named tasks in different projects. | Only the selected ID is complete. |
| [Grist invoice recalculation](tests/grist.spec.ts) | Edit the quantity on an invoice line in Chromium. | After reloading, the line shows the updated amount. The API returns the original row ID, quantity 3 and total 7500. |
| Grist item correction | Edit the Japanese item name in Chromium. | The row ID, quantity, price and amount are preserved. |
| Grist line removal | Delete one seeded line by ID through the API and reload the grid. | Only the other record remains with its original values. |
| Paperless PDF ingestion | Upload a text PDF from the dashboard. | The document list gains a new ID with the expected title and the original PDF bytes. |
| Paperless classification | Assign a correspondent and a tag to an imported document through the API. | A fresh API read returns both IDs for that document. |
| Paperless tag filter | Open the document list filtered by one tag. | The UI includes the tagged document and excludes the control. The API returns exactly the tagged ID. |
| Snipe-IT checkout | Lend an asset via API. | A fresh read returns the intended user ID and the UI displays the asset tag. |
| Snipe-IT check-in | Return an assigned asset via API. | The same ID has no assignee after check-in. |
| Snipe-IT model identity | Check out one of two assets of the same model. | The two IDs retain distinct assignment states. |
| WordPress draft visibility | Save a Japanese draft as an editor. | Its ID and raw text match the editor API response. An anonymous reader cannot retrieve the draft or read it at its URL. |
| WordPress publication | Publish a draft through Quick Edit in the posts list. | The public API and a fresh reader session see the same post and text. |
| WordPress correction | Correct the body of a published announcement through the editor API. | The original URL shows the correction after reload and the post keeps its ID. |

## Test environment

[Docker Compose](compose.yaml) starts Gitea 1.27.3 with SQLite and Vikunja 0.24.6 with PostgreSQL 16, alongside Grist 1.7.20 in single-user mode on the isolated Compose network. Paperless-ngx 3.5.1 uses its local database and a Redis broker. Its dashboard uses automatic login inside the test network. The test container reaches all six applications over the Compose network without publishing host ports. Each run gets a separate Compose project and a generated password. On exit, the runner removes that project's containers and volumes. Reports remain on the host.

All six applications use the same [Playwright configuration](playwright.config.ts) and HTML reporter. The suite runs Chromium with one worker and zero test retries. The [GitHub Actions workflow](.github/workflows/regression.yml) calls the same `bash run.sh` entry point on Ubuntu for pushes, pull requests, and manual runs. After a completed test run, the workflow uploads the HTML report, including when a test fails. Artifact retention is set to 14 days.

## Troubleshooting and artifacts

Run `docker info` and `docker compose version` from the same shell if startup fails. Open the printed HTML file to inspect a test and its attachments. Keep the entire HTML directory together. Reports can include screenshots, visible input values and internal URLs. Older reports from revision `72da163` also contain the disposable login password in recorded input steps. Review them before sharing. The test accounts and passwords are disposable.

The Compose service names are internal DNS names. To update Playwright, change both the test image and the npm package to the same version and regenerate the lockfile. Application image tags and the CI runner can receive upstream updates.

## Recorded results

Before this refactor, revision `72da163` passed all seven cases on WSL and in GitHub Actions (run `45093189062`). Run the suite against the current revision for its own results.

### CI evidence for the original four tests

The failure drill changed only the expected Vikunja title on a dedicated branch. The browser still submitted `月次報告の資料を確認`, while the API assertion expected `請求書を照合`. The failure report recorded both values. Reverting the assertion restored the baseline.

| GitHub Actions run | Commit | Verified result |
| --- | --- | --- |
| [Baseline](https://github.com/nha6ki/web-regression/actions/runs/45025068822) | `c06a2ee` | All four tests passed. |
| [Title mismatch](https://github.com/nha6ki/web-regression/actions/runs/45026775483) | `c1c92d3` | Only the Vikunja test failed. All three Gitea tests passed, and the failure report was saved. |
| [After revert](https://github.com/nha6ki/web-regression/actions/runs/45026915548) | `4d68215` | All four tests passed again, and the recovery report was saved. |

The Snipe-IT tests use MariaDB and a disposable personal access token issued inside the Compose project.

WordPress runs with its own MariaDB database, a test editor account and a separate anonymous browser session.
