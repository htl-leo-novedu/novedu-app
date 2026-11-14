---
title: Connecting Novedu to Moodle
description: Register your school's Novedu in Moodle as an LTI 1.3 external tool and set the three values Moodle shows, so students can hand in quiz results.
sidebar:
  order: 4
audience: operator
keywords: [Moodle, LTI, LTI 1.3, external tool, Externes Tool, register, Moodle administrator, Platform ID, Client ID, Deployment ID, public key, RSA key, keyset URL, MOODLE_LTI_PRIVATE_KEY, MOODLE_LTI_ISSUER, MOODLE_LTI_CLIENT_ID, MOODLE_LTI_DEPLOYMENT_ID, gradebook, operator]
related:
  - 30-sharing-activities/11-moodle-hand-in
  - 50-develop-and-evaluate/03-azure-models-with-a-budget
---

Students can hand in a Novedu quiz result to Moodle once Novedu is registered in the school's Moodle. This chapter is for the two people who set that up together: the Moodle administrator, who registers Novedu as an external tool, and the person who runs the school's Novedu, who sets the values Moodle hands back. Teachers then add quizzes to their courses on their own; the chapter on handing in quiz results to Moodle covers their part.

## What the Moodle connection is, and what it isn't

Novedu connects to Moodle through LTI 1.3 (Learning Tools Interoperability), the standard way Moodle talks to external tools, together with its grade service.

- **No Moodle plugin** is installed, and no Moodle password or API key is exchanged. Both sides prove who they are with signed messages: Novedu with its own key pair, Moodle with its own.
- **What Novedu receives** when a student opens a Novedu activity: the student's name, their Moodle username, and their internal Moodle user id. Novedu receives no email address.
- **What Novedu keeps:** the Moodle user id, and only after the student has confirmed that their Moodle account and their Novedu account belong together. The name and username are shown to the student once on that confirmation page and never stored.
- **What Novedu can do in Moodle:** write grades into the grade columns of its own activities, nothing else.
- Students still sign in to Novedu with their usual account. Moodle never signs anyone in to Novedu.

One Novedu connects to one Moodle, through one registration.

## Who does what

1. **The person who runs Novedu** creates Novedu's key and sets it on the server. Novedu's **Settings** page then shows the addresses the Moodle administrator needs.
2. **The Moodle administrator** registers Novedu in Moodle with those addresses and sends back three values from Moodle.
3. **The person who runs Novedu** sets those three values on the server and restarts Novedu.
4. **Teachers** add Novedu activities to their courses.

## Novedu: create the key

Novedu signs its messages to Moodle with an RSA key. Create one, for example with OpenSSL:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out novedu-moodle-key.pem
```

The file holds the private key in PKCS#8 PEM format (it starts with `-----BEGIN PRIVATE KEY-----`). Treat it as a secret: store it where your server keeps its other secrets, give it to Novedu as the setting `MOODLE_LTI_PRIVATE_KEY`, and restart Novedu. The value may contain real line breaks, or `\n` in place of each line break when your configuration only takes one line.

Each Novedu installation gets its own key. If you run a test and a production Novedu, each one has its own key and its own registration in Moodle.

With the key set, a teacher account sees a **Moodle connection** section on Novedu's **Settings** page. Under "Give these to your Moodle administrator" it lists:

- **Tool URL and redirect URI**, the address ending in `/api/lti/launch`,
- **Login URL**, ending in `/api/lti/login`,
- **Key set URL**, ending in `/api/lti/jwks`,
- the **public key** as PEM text, for the variant described under "When Moodle can't reach Novedu".

Each one has a copy button. The section says "Not connected yet" until the three values from Moodle are set.

## Moodle administrator: register Novedu

Open **Site administration** → **Plugins** → **Activity modules** → **External tool** → **Manage tools** (in a German Moodle: **Website-Administration** → **Plugins** → **Aktivitäten** → **Externes Tool** → **Tools verwalten**). Select **configure a tool manually** (**Tool manuell konfigurieren**) and expand all sections of the form.

### Tool settings (Tool-Einstellungen)

| Field (English) | Field (German) | Value |
| --- | --- | --- |
| Tool name | Name des Tools | `Novedu` |
| Tool URL | Tool URL | Novedu's **Tool URL and redirect URI** |
| LTI version | LTI Version | `LTI 1.3` |
| Public key type | Öffentlicher Schlüsseltyp | **Keyset URL** (**Schlüsselsatz-URL**) |
| Public keyset | Öffentlicher Schlüsselsatz | Novedu's **Key set URL** |
| Initiate login URL | Anmelde-URL | Novedu's **Login URL** |
| Redirection URI(s) | Umleitungs-URI(s) | Novedu's **Tool URL and redirect URI** (the same address as Tool URL) |
| Custom parameters | Angepasste Parameter | leave empty |
| Tool configuration usage | Verwendung der Toolkonfiguration | **Show in activity chooser and as a preconfigured tool** (**In Aktivitätsauswahl und als vorkonfiguriertes Tool anzeigen.**) |
| Default launch container | Standard-Startcontainer | **New window** (**Neues Fenster**) |
| Supports Deep Linking (Content-Item Message) | Unterstützt Deep Linking (Content-Item Message) | ticked |

**New window** matters: when Novedu opens embedded inside the Moodle page, the browser hides the student's Novedu sign-in from it, and the student can't sign in there. Deep Linking gives teachers the **Select content** button that picks a Novedu quiz by its code.

### Services

| Field (English) | Field (German) | Value |
| --- | --- | --- |
| IMS LTI Assignment and Grade Services | IMS LTI Aufgaben und Bewertung | **Use this service for grade sync only** (**Service nur für Bewertungen nutzen**) |
| IMS LTI Names and Role Provisioning | IMS LTI Namen und Rollenbereitstellung | **Do not use this service** (**Diesen Service nicht nutzen**) |
| Tool Settings | Tool-Einstellungen | **Do not use this service** (**Diesen Service nicht verwenden**) |

### Privacy (Datenschutz)

| Field (English) | Field (German) | Value |
| --- | --- | --- |
| Share launcher's name with tool | Anwendername an Tool übergeben | **Always** (**Immer**) |
| Share launcher's email with tool | E-Mail des Anwenders an Tool übergeben | **Never** (**Nie**) |
| Accept grades from the tool | Bewertungen aus dem Tool akzeptieren | **Always** (**Immer**) |
| Force SSL | SSL festlegen | ticked when Novedu runs on `https` |

**Always** for the name matters: Novedu shows the name to the student on the one-time confirmation page, and without it no student can link their accounts, so nobody can hand in. Moodle offers no way to share the name without the username.

Leave **Restrict to category** (**Auf Kursbereich beschränken**) and **Miscellaneous** (**Verschiedenes**) unchanged, and save.

## Moodle administrator: send three values back

The tool now appears in the tool list as active. Open its configuration details from the tool's card. Moodle shows six values; Novedu needs three of them:

| English | German | Novedu setting |
| --- | --- | --- |
| Platform ID | Plattform-ID | `MOODLE_LTI_ISSUER` |
| Client ID | Client-ID | `MOODLE_LTI_CLIENT_ID` |
| Deployment ID | Deployment-ID | `MOODLE_LTI_DEPLOYMENT_ID` |

None of them is a secret, so email is fine. Novedu works out Moodle's other three addresses from the Platform ID by itself.

## Novedu: set the values and restart

Set the three values on the Novedu server, next to `MOODLE_LTI_PRIVATE_KEY`, and restart Novedu. The **Moodle connection** section on **Settings** then says "Connected to" followed by your Moodle's Platform ID, and teachers see the option **Students can hand in results to Moodle** when they create a quiz code.

Moodle hand-in is on only when all four settings are set. With one or two of the three Moodle values missing, Novedu treats the connection as not set up and writes a warning that names the missing setting to its log. To connect a different Moodle, change the values and restart. Account links made with the earlier Moodle stay stored but are not used with the new one.

To replace the key, set the new one and restart. With the **Keyset URL** registration, Moodle picks the new key up on its own. With a pasted key, the Moodle administrator pastes the new public key into the registration.

## When Moodle can't reach Novedu: the pasted key

Moodle's server fetches Novedu's public key from the **Key set URL** each time Novedu asks for permission to write a grade. If Moodle's server can't reach Novedu's address, register Novedu with the key itself instead:

| Field (English) | Field (German) | Value |
| --- | --- | --- |
| Public key type | Öffentlicher Schlüsseltyp | **RSA key** (**RSA-Schlüssel**) |
| Public key | Öffentlicher Schüssel | the **public key** text from Novedu's **Settings** page |

Everything else stays as above. Moodle then never contacts Novedu at all; all traffic from Moodle to Novedu goes through the students' and teachers' browsers. Novedu's server still has to reach Moodle, to fetch Moodle's own key and to deliver grades.

## Check the connection

1. In a test course, add a Novedu activity and pick a quiz code with **Select content**. The quiz code needs **Students can hand in results to Moodle** ticked.
2. Open the activity as a student of that course, link the accounts when Novedu asks, finish the quiz, and select **Hand in**.
3. Open the course's gradebook and look for the grade and the comment "Novedu quiz: …" in the activity's column.

Use a test course: grades that arrive are real gradebook entries.

## When the hand-in fails

- **The hand-in fails, although launching works.** Moodle's server could not fetch Novedu's key. In its default settings Moodle blocks requests to internal addresses and to ports other than 80 and 443 (**Site administration** → **General** → **Security** → **HTTP security**: the lists of blocked hosts and allowed ports). A Novedu on a public `https` address needs no change. Otherwise either allow Novedu's address and port there, or register with the pasted key.
- **Novedu opens inside the Moodle page** and students can't sign in. Set **Default launch container** to **New window**; check that the activity itself doesn't override it.
- **Students see "Your Moodle doesn't share your name with Novedu".** Set **Share launcher's name with tool** to **Always**.
- **Teachers don't see the Moodle option on the quiz code form.** Novedu isn't connected yet: check the **Moodle connection** section on **Settings**.

## Moodle versions

The connection is checked with Moodle 4.5 and Moodle 5.3. The registration form is the same in both, field for field.
