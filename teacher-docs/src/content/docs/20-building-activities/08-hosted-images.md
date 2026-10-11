---
title: Hosting images
description: Upload an image in Novedu and show it in a quiz question by name, without running your own image hosting.
sidebar:
  order: 8
audience: teacher
keywords: [image, picture, diagram, upload, hosted, credit, alt text, quiz image, owner]
related:
  - 20-building-activities/04-quizzes
  - 20-building-activities/01-handling-yaml
  - 10-yaml-for-teachers/04-cli-validation
  - 40-ai-llms/01-novedu-cli
---

A picture often explains more than a paragraph: a diagram in a quiz question, a
map, a chart students should interpret. You can host such images directly in
Novedu. The image gets a stable name, you don't need a public web server, and
every quiz you write can reference it by that name.

## Upload an image in the app

Open the **Images** page in the app (you need a teacher account).

1. Select **New image**.
2. Enter a name. Use only letters, digits, underscores, and hyphens, for
   example `compass-rose` or `sorting_diagram_1`.
3. Pick the file: a PNG, JPEG, or SVG, at most 5 MB.
4. Optionally add a credit line, for example a licence notice like
   `Compass rose — CC BY 4.0`. It appears in small print under the image
   wherever the image is shown.
5. Upload. The image appears in your list, and the name is ready to use in
   your YAML.

The list holds every teacher's images, and it opens on your own: the **Owner**
box starts on your name. Pick **All owners** to see everyone's images, pick a
colleague to see only theirs, or select **Clear** to come back to your own. You
can also filter by name, and sort by any column header. The **View** button
opens an image so you can check you picked the right one.

An image's owner is whoever saved it last, the same rule that applies to hosted
activity files. Uploading an image under a name that is already taken is
rejected, so an image only changes hands if someone deletes it and uploads a new
one under the same name.

## Upload an image with the CLI

If you already work in the terminal, or you let a coding agent manage your
activities, the `novedu-cli` command line does the same job (the introduction
chapter on the Novedu CLI and its AI skill covers the CLI itself; sign in once
with `novedu-cli login`):

```bash
npx @novedu/cli images upload compass-rose --file ./compass-rose.png --credit "CC BY 4.0"
npx @novedu/cli images list
```

`images upload` needs the file via `--file`; the type comes from the file
extension (`.png`, `.jpg`/`.jpeg`, or `.svg`). `images list` shows your images
the same way the Images page does.

## Show the image in an activity

Reference a hosted image from your activity YAML by its **name**, with
`hosted: true`. For example, above a quiz question:

```yaml
image:
  hosted: true # look the image up by NAME in the app's image store
  src: sample-compass-rose # the hosted name
  alt: A compass rose showing the four cardinal directions. # accessible description
  credit: Compass rose — CC BY 4.0 # optional, overrides the stored credit
```

- `src` is the name you chose at upload, not a link.
- `alt` is the accessible description read aloud by screen readers; write it in
  the YAML for each place you use the image.
- `credit` is optional here: without it, the credit stored at upload is shown.

Image blocks work in quizzes only, one optional image per question. Tutor,
fragment, writing, coding, and cloze files have no image block.

## Replace or delete an image

An uploaded image can't be edited or overwritten. To replace one, delete it on
the **Images** page (tick it, then **Delete Selected**) and upload the new file
under the same name. Activities that reference the name then show the new
image. Deleting is only possible in the app, not with the CLI; an activity that
references a deleted name simply shows no image.

## Three things to get right

- Reference images by **name** with `hosted: true`, never by pasting a link.
  The link the image list offers only opens for a signed-in Novedu user, in a
  browser; the name keeps working everywhere, including in the YAML.
- A name that is already taken is rejected, in the app and in the CLI alike.
  Pick a new name, or delete the old image first if you want to replace it.
- Hosting an image is not the same as letting students **answer** with a photo.
  Photo answers are a quiz setting (`imageInput`); hosted images are pictures
  you show to students.
