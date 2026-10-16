# Scope

Teacher docs describe what a teacher does, sees, and chooses. They do not describe
how the app is built inside.

This is not secrecy: the code is open source, nothing here is hidden. The reasons are
**relevance** (implementation detail is noise for a teacher who just wants to run an
activity) and **drift** (anything tied to a file, function, route, or table name goes
stale when the code changes). So describe stable, observable behavior and leave the
mechanism out.

- Write "Only you and other teachers can see a code's statistics and student
  conversations", not how sign-in or permissions work.
- Write "The link stops working when the time window closes or you delete the code",
  not how access is checked.
- Write "You can run an activity on the school's AI server or on Azure, chosen per
  code", not how either one connects.
- Write "Deleting a code also deletes its statistics", not how they are stored.

If a piece of the source has no teacher-facing effect, it is not documentation. If a
chapter seems to need one, the outline is reaching past the teacher's world: cut it or
restate it as behavior the teacher observes.

Engineer docs (`docs/**`) are inputs, never edited from here.