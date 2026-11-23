<?php
define('CLI_SCRIPT', true);
require '/var/www/html/config.php';
require_once $CFG->dirroot . '/course/lib.php';
require_once $CFG->dirroot . '/course/modlib.php';
require_once $CFG->dirroot . '/user/lib.php';
require_once $CFG->libdir . '/enrollib.php';

$stage = 'site settings';
set_exception_handler(static function (Throwable $error) use (&$stage): void {
    // DML debug output may include bound values. Report only database identifiers.
    $detail = (string)($error->debuginfo ?? '');
    $context = [];
    foreach (['column', 'relation', 'constraint'] as $kind) {
        if (preg_match('/\b' . $kind . ' "([a-zA-Z0-9_]+)"/i', $detail, $match)) {
            $context[] = $kind . '=' . $match[1];
        }
    }
    $code = $error instanceof moodle_exception ? $error->errorcode : (string)$error->getCode();
    file_put_contents('php://stderr', sprintf("Moodle fixture failed [%s]: %s (%s) %s\n",
        $stage, get_class($error), $code, implode(' ', $context)));
    exit(1);
});

\core\session\manager::set_user(get_admin());
$CFG->noemailever = true;
set_config('noreplyaddress', 'noreply@example.test');
set_config('enablewebservices', 1);
set_config('webserviceprotocols', 'rest');
set_config('enablemobilewebservice', 1);
$DB->set_field('external_services', 'enabled', 1, ['shortname' => 'moodle_mobile_app']);

$stage = 'create course';
$course = create_course((object)[
    'category' => 1, 'fullname' => '提出と採点', 'shortname' => 'QA-COURSE',
    'format' => 'topics', 'numsections' => 1,
]);
course_create_sections_if_missing($course, [1]);
$instances = enrol_get_instances($course->id, true);
$manual = enrol_get_plugin('manual');
$enrolment = null;
foreach ($instances as $instance) {
    if ($instance->enrol === 'manual') {
        $enrolment = $instance;
        break;
    }
}
if (!$enrolment) {
    throw new RuntimeException('Manual enrolment missing');
}
$system = context_system::instance();
$restrole = null;
$ids = [];
foreach (['qateacher' => 'editingteacher', 'qastudentone' => 'student', 'qastudenttwo' => 'student'] as $name => $role) {
    $stage = "create user $name";
    $id = user_create_user((object)[
        'username' => $name, 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
        'firstname' => 'QA', 'lastname' => $name, 'email' => $name . '@example.test',
        'password' => getenv('QA_PASSWORD'),
    ]);
    $roleid = $DB->get_field('role', 'id', ['shortname' => $role], MUST_EXIST);
    $stage = "enrol $name";
    $manual->enrol_user($enrolment, $id, $roleid);
    $stage = "check REST access for $name";
    if (!has_capability('webservice/rest:use', $system, $id)) {
        if ($restrole === null) {
            $restrole = create_role('QA REST client', 'qarestclient', 'REST access for regression fixtures');
            assign_capability('webservice/rest:use', CAP_ALLOW, $restrole, $system->id);
        }
        role_assign($restrole, $id, $system->id);
        if (!has_capability('webservice/rest:use', $system, $id)) {
            throw new RuntimeException('Fixture account cannot use REST');
        }
    }
    $ids['users'][$name] = (int)$id;
}

foreach (['file' => '提出ファイルの照合', 'feedback' => '採点結果の確認', 'separate' => '学生別の採点'] as $key => $name) {
    $stage = "create assignment $key";
    $assignment = create_module((object)[
        'modulename' => 'assign', 'course' => $course->id, 'section' => 1, 'name' => $name,
        'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
        'groupmode' => 0, 'groupingid' => 0, 'showdescription' => 0, 'visible' => 1, 'grade' => 100,
        'assignsubmission_file_enabled' => 1, 'assignsubmission_file_maxfiles' => 1,
        'assignsubmission_file_maxsizebytes' => 1048576, 'assignfeedback_comments_enabled' => 1,
        'submissiondrafts' => 0, 'teamsubmission' => 0, 'markingworkflow' => 0,
        'activityeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
        'submissionattachments' => 0, 'alwaysshowdescription' => 1,
        'allowsubmissionsfromdate' => 0, 'duedate' => 0, 'cutoffdate' => 0, 'gradingduedate' => 0,
        'sendnotifications' => 0, 'sendlatenotifications' => 0, 'sendstudentnotifications' => 0,
        'requireallteammemberssubmit' => 0, 'blindmarking' => 0, 'markingallocation' => 0,
        'timelimit' => 0, 'maxattempts' => 1,
        'requiresubmissionstatement' => 0, 'attemptreopenmethod' => 'none',
    ]);
    $ids['tasks'][$key] = ['id' => (int)$assignment->instance, 'cm' => (int)$assignment->coursemodule];
}
if (!file_put_contents('/tmp/qa-assignment-ids.json', json_encode($ids, JSON_THROW_ON_ERROR))) {
    throw new RuntimeException('Could not save course IDs');
}
