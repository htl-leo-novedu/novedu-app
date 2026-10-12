---
title: "DEV and PROD: the two Novedu environments"
description: Novedu runs twice, as PROD for your classes and as DEV for trying new features and activities. Which one to use when, and what happened to the prototype.
sidebar:
  order: 7
audience: teacher
keywords: [DEV, PROD, environment, app.novedu.at, dev.novedu.at, novedu.at, test, stable, prototype, migration, old codes]
related:
  - 00-introduction/02-shareable-codes
  - 40-ai-llms/01-novedu-cli
  - 30-sharing-activities/01-creating-codes
---

Novedu runs in two separate environments, two copies of the app side by side. Both look the same and you sign in to both with your usual school account, but they serve different purposes.

| | PROD | DEV |
| --- | --- | --- |
| Address | [app.novedu.at](https://app.novedu.at) | [dev.novedu.at](https://dev.novedu.at) |
| App version | the latest stable release | the latest version, with the newest features |
| Use it for | activities and codes you really use in class | trying new features, and experimenting with activities while you develop your material |
| Your data | kept | kept, but without a guarantee |
| Availability | meant to be available whenever your class needs it | no guarantee: it can be down, change, or behave differently from one day to the next |

## PROD: for your classes

PROD (short for production) at [app.novedu.at](https://app.novedu.at) runs the latest stable release of Novedu. Every activity you hand to a class belongs on PROD: create its code there, share the PROD link, and your students work there. A new feature arrives on PROD once it has proven itself on DEV.

## DEV: for trying things out

DEV (short for development) at [dev.novedu.at](https://dev.novedu.at) always runs the newest version of Novedu. Use DEV to:

- **Try the latest Novedu features** before they reach PROD.
- **Experiment with your activities** while you develop your material: create a code, open it yourself, adjust the activity file, and try again.

Students can sign in to DEV too, so you can also try an activity together with a few students. DEV keeps its data, but there is no guarantee for it and no guarantee that DEV is available at a given moment. So don't plan a lesson around DEV.

## The two environments are separate

PROD and DEV share nothing but your school account. Everything you create lives only in the environment you created it in:

- A code created on DEV works only on DEV, and a PROD code only on PROD. The link you share shows which one it is, because it starts with the environment's address.
- Activity files and images you upload to Novedu are stored per environment. To use an uploaded file on PROD, upload it to PROD as well.
- Your students' conversations and saved texts stay in the environment where they were written.

The Novedu command-line tool (the CLI) works with PROD unless you tell it otherwise, and it can be pointed at DEV. You sign in to each environment separately.

## How to tell where you are

A colored strip under the top bar names the environment on every page: green for PROD, yellow for DEV. The address in your browser shows it too, `app.novedu.at` or `dev.novedu.at`. If the strip gets in your way, select the **×** at its right end. It stays hidden until you open Novedu in a new tab or restart your browser. This teacher guide has an address of its own, `docs.novedu.at`, and is the same for PROD and DEV, so it shows no strip.

## What we had during the prototype phase

During its prototype phase, Novedu ran as a single app at novedu.at. That app has been shut down, and its data (codes, activity files, images, students' saved texts, reports, and usage statistics) was moved to DEV. Chat histories were not moved, so a conversation from that time opens empty, and everyone signs in again once (students of a coding activity also request a new personal key). You can use DEV to continue activities that started during the prototype phase: an old link keeps working if you replace `novedu.at` with `dev.novedu.at` (for example, `https://dev.novedu.at/abc123` instead of `https://novedu.at/abc123`). New exercises with Novedu in class belong on PROD, because DEV comes with no guarantee of availability: create fresh codes for them on PROD.
