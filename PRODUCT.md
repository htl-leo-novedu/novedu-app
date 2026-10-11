# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Scope: the Next.js web app at the repo root. The CLI and the teacher guide (docs.novedu.at) are separate surfaces, not governed by this file.

## Users

What Novedu is and its five kinds of activity: [What is Novedu](teacher-docs/src/content/docs/00-introduction/01-what-is-novedu.md). How students get in: [What is a shareable code](teacher-docs/src/content/docs/00-introduction/02-shareable-codes.md).

- **Students come first.** Students at an Austrian technical secondary school (HTL) arrive mid-lesson or on an assignment, through a link their teacher shared, with a task to finish. They didn't choose the tool and owe it no attention, so every student screen has to make the activity obvious and get out of the way.
- **The start page is the one playful surface.** A student's own home (`/`) rewards coming back: XP, levels, a weekly streak, a 26-week calendar and badges, visible only to that student and never compared with anyone ([docs/home.md](docs/home.md)). Getting back into an activity still comes first on it. A teacher's `/` is a back-office dashboard over their own codes, with their own badges (no XP) at its foot.
- **Teachers come second.** They use a power-user back office (codes, files, images, reports, usage) and often work from the CLI instead. They value density, scanability, and predictability over guidance.

## Product Purpose

Success for a student: opening a code gives them a focused, trustworthy learning experience that feels like their teacher's activity, not like a generic AI app. Success for a teacher: going from an idea to a working activity, trying it, and revising it without friction.

## Positioning

- **The teacher controls the AI.** Activities run on readable, revisable instructions the teacher writes ([Why YAML](teacher-docs/src/content/docs/10-yaml-for-teachers/01-why-yaml.md)).
- **Pedagogy over answers.** Tutors guide instead of solving; the writing coach can read but never edit the draft ([Writing overview](teacher-docs/src/content/docs/00-introduction/05-writing-overview.md)).
- **School-specific activity kinds.** Graded open-answer quizzes, assisted writing, teacher-configured coding help, and gap texts (cloze) whose feedback connects related mistakes, not just a chat.

## Operating Context

- **Mixed devices.** Students use phones too (photos of handwritten quiz answers), but laptops and desktops are the main screens for chat and writing. Teacher tools are desktop-first.
- **Two environments.** Production for class use, dev for trying things out. An environment ribbon marks which one you're on ([Environments](teacher-docs/src/content/docs/00-introduction/07-environments.md)).
- **One vocabulary.** "Activity" and "code" are the core nouns; tutor, quiz, writing, coding, and cloze are *kinds of activity*. Use the same terms in the UI as in the teacher guide.

## Capabilities and Constraints

- **English UI**, and it stays English even though the users are Austrian.
- **Multi-school is on the roadmap.** Don't design as if there will only ever be one school, e.g. in naming, chrome, or sign-in.
- **The UI never weakens the system's privacy and access rules.** Grading guidance stays server-side, and model reasoning is shown only to teachers. The rules are in `AGENTS.md`; the per-area details are in `docs/` (e.g. [chat](docs/chat.md), [codes](docs/codes.md)).
- **Honest about what is recorded.** Whether an activity is anonymous or per-user changes what students should be told ([Anonymous vs per-user](teacher-docs/src/content/docs/30-sharing-activities/04-anonymous-vs-per-user.md)). Reports always carry the reporter's identity, and the form says so ([Student reports](teacher-docs/src/content/docs/30-sharing-activities/07-student-reports.md)).
- **An early product that changes quickly.** Favor patterns that hold up as features are added over bespoke one-offs. The implementation conventions are in [docs/styling.md](docs/styling.md).

## Brand Commitments

- Name **Novedu**; logo files are in `novedu-brand-assets/`.
- Teacher-facing copy follows the teacher guide's voice ([teacher-docs/style.md](teacher-docs/style.md)): second person, task-first, short, no internal names.

## Evidence on Hand

- Real activities for realistic content: `activities/examples/` and `activities/{tutors,quizzes,writings,coding}/`.
- There are no testimonials, quotes, school logos, usage statistics, or outcome studies. Never fabricate any.

## Product Principles

1. **Students first.** When a student surface and a teacher surface compete for attention or polish, the student surface wins.
2. **The teacher's design is the product.** The UI frames the teacher-authored activity; it never adds its own pedagogy, persona, or opinions on top.
3. **The student stays the author.** Interfaces support doing the work, never shortcut it.
4. **Trust by construction, and visibly so.** The UI is honest about what is shared, recorded, or attributed.
5. **Readable and revisable.** Teachers can always see and change what the AI was told to do.
