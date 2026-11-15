<?php
// Prints every activity grade with its feedback — the gradebook as the teacher sees it.
//   bin/moodle-docker-compose exec -T webserver php grades.php
define('CLI_SCRIPT', true);
require(__DIR__ . '/config.php');
$rows = $DB->get_records_sql("SELECT gg.id, c.shortname, gi.itemname, gi.grademax, u.username, gg.finalgrade, gg.feedback, gg.timemodified
  FROM {grade_grades} gg JOIN {grade_items} gi ON gi.id = gg.itemid JOIN {user} u ON u.id = gg.userid JOIN {course} c ON c.id = gi.courseid
  WHERE gi.itemtype = 'mod' ORDER BY gg.id");
foreach ($rows as $r) {
    echo "{$r->shortname} | {$r->itemname} | max " . (float)$r->grademax . " | {$r->username} | final "
        . var_export($r->finalgrade === null ? null : (float)$r->finalgrade, true)
        . " | feedback " . var_export($r->feedback, true) . "\n";
}
