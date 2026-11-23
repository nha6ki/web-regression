import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

type Task = { id: number; cm: number };
type Course = { users: Record<string, number>; tasks: Record<string, Task> };
const student = 'qastudentone';
const peer = 'qastudenttwo';

function fixtures(): Course {
  if (!process.env.MOODLE_FIXTURES) throw new Error('Start Moodle with bash run.sh');
  return JSON.parse(process.env.MOODLE_FIXTURES);
}

async function session(api: APIRequestContext, username: string) {
  const res = await api.post('/login/token.php', { form: {
    username, password: runPassword(), service: 'moodle_mobile_app',
  } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  if (!body.token) throw new Error('Moodle login: ' + (body.errorcode || 'no token'));
  return body.token as string;
}

async function call(api: APIRequestContext, token: string, method: string,
  args: Record<string, string | number>) {
  const res = await api.post('/webservice/rest/server.php', { form: {
    wstoken: token, wsfunction: method, moodlewsrestformat: 'json', ...args,
  } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  if (body?.exception) throw new Error(method + ': ' + body.errorcode + ' ' + body.message);
  return body;
}

async function submit(api: APIRequestContext, username: string, task: Task, text: string) {
  const token = await session(api, username);
  const upload = await api.post('/webservice/upload.php', { multipart: {
    token, filearea: 'draft', itemid: '0', file: {
      name: '課題レポート.txt', mimeType: 'text/plain', buffer: Buffer.from(text),
    },
  } });
  expect(upload.status()).toBe(200);
  const result = await upload.json();
  const draft = Number(result[0]?.itemid);
  expect(draft, 'Uploaded file should have a draft item ID').toBeGreaterThan(0);
  const warnings = await call(api, token, 'mod_assign_save_submission', {
    assignmentid: task.id, 'plugindata[files_filemanager]': draft,
  });
  expect(warnings).toEqual([]);
  const state = await call(api, token, 'mod_assign_get_submission_status', { assignid: task.id });
  expect(state.lastattempt.submission.status).toBe('submitted');
}

async function grade(api: APIRequestContext, teacher: string, task: Task, userId: number, score: number, comment: string) {
  await call(api, teacher, 'mod_assign_save_grade', {
    assignmentid: task.id, userid: userId, grade: score, attemptnumber: -1,
    addattempt: 0, workflowstate: '', applytoall: 0,
    'plugindata[assignfeedbackcomments_editor][text]': comment,
    'plugindata[assignfeedbackcomments_editor][format]': 1,
  });
}

async function signIn(page: Page, username: string) {
  await page.goto('/login/index.php');
  await page.locator('#username').fill(username);
  await enterPassword(page.locator('#password'), runPassword());
  await page.locator('#loginbtn').click();
  await expect(page).not.toHaveURL(/\/login\/index\.php/);
}

test('学生の提出ファイルを教員が取得し、原本と照合する', async ({ request, page }) => {
  const { tasks, users } = fixtures();
  const text = '実験結果を提出します。\n';
  await submit(request, student, tasks.file, text);
  const teacher = await session(request, 'qateacher');
  const data = await call(request, teacher, 'mod_assign_get_submissions', { 'assignmentids[0]': tasks.file.id });
  const assignment = data.assignments.find((a: { assignmentid: number }) => a.assignmentid === tasks.file.id);
  const submission = assignment.submissions.find((s: { userid: number }) => s.userid === users[student]);
  expect(submission.status).toBe('submitted');
  const plugin = submission.plugins.find((p: { type: string }) => p.type === 'file');
  const area = plugin.fileareas.find((a: { area: string }) => a.area === 'submission_files');
  expect(area.files).toHaveLength(1);
  expect(area.files[0].filename).toBe('課題レポート.txt');
  await signIn(page, 'qateacher');
  const url = new URL(area.files[0].fileurl);
  const path = url.pathname.replace(/^\/webservice\/pluginfile\.php/, '/pluginfile.php');
  const download = await page.request.get(path + url.search);
  expect(download.status()).toBe(200);
  expect(await download.body()).toEqual(Buffer.from(text));
});

test('採点後、学生の画面に点数と講評が表示される', async ({ request, page }) => {
  const { tasks, users } = fixtures();
  await submit(request, student, tasks.feedback, '考察を提出します。');
  await grade(request, await session(request, 'qateacher'), tasks.feedback, users[student], 84, '図の説明が明確です。');
  await signIn(page, student);
  await page.goto('/mod/assign/view.php?id=' + tasks.feedback.cm);
  const feedback = page.locator('.feedback');
  await expect(feedback).toContainText(/\b84(?:\.00)?\b/);
  await expect(feedback).toContainText('図の説明が明確です。');
});

test('同じ課題を提出した2人のうち選んだ学生だけが採点される', async ({ request }) => {
  const { tasks, users } = fixtures();
  await submit(request, student, tasks.separate, '第一の提出物');
  await submit(request, peer, tasks.separate, '第二の提出物');
  const teacher = await session(request, 'qateacher');
  await grade(request, teacher, tasks.separate, users[peer], 73, '提出内容を確認しました。');
  const state = async (userid: number) => call(request, teacher, 'mod_assign_get_submission_status', {
    assignid: tasks.separate.id, userid,
  });
  const first = await state(users[student]);
  const second = await state(users[peer]);
  expect(first.lastattempt.submission).toMatchObject({ userid: users[student], status: 'submitted' });
  expect(first.lastattempt.gradingstatus).toBe('notgraded');
  expect(second.lastattempt.submission).toMatchObject({ userid: users[peer], status: 'submitted' });
  expect(Number(second.feedback.grade.grade)).toBe(73);
});
