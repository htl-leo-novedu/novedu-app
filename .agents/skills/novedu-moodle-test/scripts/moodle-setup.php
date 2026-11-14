<?php
// Prepares a local Moodle for the novedu-moodle-test skill: the German language
// pack, the accounts teacher1, student1, student2 and the course NOVEDU1 with them
// enrolled. Running it again is harmless. The password comes from the environment:
//   bin/moodle-docker-compose exec -T -e MOODLE_DEV_PASSWORD webserver php moodle-setup.php
define('CLI_SCRIPT', true);
require(__DIR__ . '/config.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');
\core\session\manager::set_user(get_admin());

$password = getenv('MOODLE_DEV_PASSWORD');
if (!$password) { fwrite(STDERR, "Set MOODLE_DEV_PASSWORD.\n"); exit(2); }

$c = new \tool_langimport\controller();
try { $c->install_languagepacks('de'); echo "lang de installed\n"; } catch (Throwable $e) { echo "lang: " . $e->getMessage() . "\n"; }
set_config('lang', 'de');

function mkuser($username, $first, $last, $password) {
    global $DB, $CFG;
    if ($u = $DB->get_record('user', ['username' => $username])) { return $u; }
    $id = user_create_user((object)[
        'username' => $username, 'password' => $password, 'firstname' => $first, 'lastname' => $last,
        'email' => "$username@example.com", 'auth' => 'manual', 'confirmed' => 1,
        'mnethostid' => $CFG->mnet_localhost_id, 'lang' => 'de',
    ]);
    return $DB->get_record('user', ['id' => $id]);
}
function mkcourse($short, $full) {
    global $DB;
    if ($c = $DB->get_record('course', ['shortname' => $short])) { return $c; }
    return create_course((object)['shortname' => $short, 'fullname' => $full, 'category' => 1]);
}
function enrol($user, $course, $roleshort) {
    global $DB;
    $role = $DB->get_record('role', ['shortname' => $roleshort], '*', MUST_EXIST);
    enrol_try_internal_enrol($course->id, $user->id, $role->id);
}
$t = mkuser('teacher1', 'Tina', 'Teacher', $password);
$s1 = mkuser('student1', 'Sam', 'Student', $password);
$s2 = mkuser('student2', 'Sue', 'Student', $password);
$course = mkcourse('NOVEDU1', 'Novedu Testkurs');
enrol($t, $course, 'editingteacher');
enrol($s1, $course, 'student');
enrol($s2, $course, 'student');
echo "teacher1 {$t->id} student1 {$s1->id} student2 {$s2->id} course NOVEDU1 {$course->id}\n";
echo "release {$CFG->release}\n";
