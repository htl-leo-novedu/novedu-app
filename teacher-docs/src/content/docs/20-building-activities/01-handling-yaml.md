---
title: Publishing your YAML file
description: Make your activity file reachable for Novedu, either through a public GitHub URL or by uploading it on the Files page.
sidebar:
  order: 1
audience: teacher
keywords: [publish, YAML file, GitHub, raw URL, upload, Files page, file URL, edit file, owner]
related:
  - 10-yaml-for-teachers/04-cli-validation
  - 40-ai-llms/01-novedu-cli
  - 30-sharing-activities/01-creating-codes
  - 20-building-activities/02-available-llms
---

You've written an activity in YAML. Before you can hand it to a class, Novedu has to be able to read it. Novedu doesn't store your activity inside a code; it reads the file from its web address every time students use it. So the last authoring step is giving your file such an address.

There are two ways to do that, and both work equally well:

- **Host it on GitHub** in a public repository and use the file's raw URL.
- **Upload it in the app** on the Files page, and let Novedu host it for you.

Pick whichever fits how you work. GitHub gives you version history and works well if you already keep teaching material there; the Files page needs no account or tooling beyond Novedu itself, and it keeps the file away from students.

## Option A: host the file on GitHub

Put your YAML file in a **public** GitHub repository, then use the file's raw URL, the address that returns the plain file content rather than the GitHub page around it.

1. Commit the file and **push** it to GitHub.
2. Open the file on the GitHub website and select **Raw**.
3. Copy the address from your browser. It looks like `https://raw.githubusercontent.com/<owner>/<repository>/refs/heads/main/<path-to-file>.yaml`.
4. Paste that URL into the form when you create a code for the activity.

One thing to get right: Novedu reads the **pushed** version, not the copy on your computer. If you edit the file locally and forget to commit and push, students keep seeing the old version. Push first, then test.

## Option B: upload the file in the app

The Files page in Novedu lets you create and edit activity files without any hosting of your own. The app stores the file and gives it an address that only teachers can read.

1. Open the Files page and select **New file**.
2. Give the file a name (letters, digits, hyphens, and underscores only, no spaces) and pick its kind: tutor, fragment, quiz, writing, or coding.
3. Write the YAML in the editor, or select **Upload file…** to load a file from your computer into it.
4. Select **Validate** to check the YAML without saving, as often as you like.
5. Select **Validate & create** to save.

Saving always validates first: an invalid file is never stored, so anything the Files page has published is a file Novedu can actually run. After saving, the edit page shows the file's **File URL** with a copy button; that address is what you use when you create a code. The file list also offers a **Create code** shortcut next to each activity file, which starts the code form with the file already filled in.

## Who can read an uploaded file

Students can't read a file you uploaded on the Files page, even if they know its name or address. Novedu reads the file itself to run the activity, but nobody else gets the raw YAML. That makes the Files page the right place for an exam: the questions and the grading instructions stay private.

Opening an uploaded file's address in a browser doesn't show the file, not even for a teacher. To look at a file, open it on the Files page. The Novedu CLI can read uploaded files too, once you've signed in with your teacher account (`novedu-cli login`).

A file on GitHub works differently: in a public repository, anyone can read it, students included. Keep exams off public GitHub.

## Finding a file in the list

The Files page holds every teacher's files, and it opens on your own: the **Owner** box starts on your name. Pick **All owners** to see everyone's files, pick a colleague to see only theirs, or select **Clear** to come back to your own. You can also filter by name, title, and description, and sort by any column header.

A file's owner is whoever **saved it last**, not whoever created it. So if you edit a colleague's file, it becomes yours: it moves out of their default view and into yours. Nothing is lost, and everyone can still find it under **All owners** or by name, but it is worth knowing before you wonder where a file went.

If you prefer the command line, the Novedu CLI can upload a file too, with `novedu-cli files upload <name> --file <path> --kind <kind>`, and it runs the same validation on the server.

## Editing the file later

A published file is not frozen. Novedu reads the current published version each time students use the activity, so your changes reach the class without touching any existing codes.

- **GitHub**: edit, commit, and push. The pushed version is live immediately.
- **Files page**: open the file, edit, and select **Validate & save**. The saved version is live immediately, and the address stays the same.

Deleting an uploaded file makes its address stop working, so any code that points at it stops working too.

## Files that reference other files

A tutor can pull in a shared fragment library by URL, and that URL may be relative. A relative reference resolves against the activity's own address, wherever it is published. The sorting-algorithms sample tutor does exactly that:

```yaml
prompt:
  fragment_files:
    - id: general_fragments
      url: "../shared/general-fragments.yaml"
```

On GitHub this means the shared library has to sit in the repository next to the tutor, in the place the relative path expects. For uploaded files, `./other-file` points at another uploaded file called `other-file`. If the pieces live in different places, use a full `https://` URL instead of a relative one.
