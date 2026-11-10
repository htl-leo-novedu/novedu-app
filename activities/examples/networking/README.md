# Networking — a tutor that draws on the whiteboard

A single **tutor** activity that shows off one feature: the built-in **`board`**
tool. The tutor sketches what it explains on a whiteboard next to the chat — a DHCP
handshake, an address split into network and host bits, a VNet with its subnets —
and changes the **same** drawing when the student follows up.

| File | Kind | What it demonstrates |
| --- | --- | --- |
| [`network-board-tutor.yaml`](network-board-tutor.yaml) | tutor | `tools: [board]`, the recommended whiteboard paragraph, topic-specific drawing hints |

## What the student sees

1. The student asks "Wie bekommt mein Laptop seine IP-Adresse?". The tutor answers
   in a few sentences and draws the DHCP handshake as a sequence: laptop and DHCP
   server, four numbered messages. On a laptop the board opens beside the chat; on a
   phone it docks above the chat.
2. "Kannst du den Schritt markieren, wo mein Laptop das ganze Netz fragt?" — the
   tutor highlights the Discover broadcast **in place**: the arrow gets a marker
   behind its label, everything else fades. On a phone the board zooms to it.
3. "Und was, wenn ein zweiter DHCP-Server antwortet?" — the tutor adds the second
   server and its offer to the existing drawing.

Under each reply that changed the board, a small "Drew on the board" / "Changed
the board" marker appears in the chat; clicking it opens the board. The drawing
comes back after a reload and with "Previous conversations"; "Start over" clears
it. Students only look at the drawing; they do not draw themselves.

## How the YAML gets there

- **`tools: [board]`** grants the tool. The platform never tells the model about its
  tools, so the instructions do: the paragraph starting "You have a whiteboard next
  to the chat" is the recommended one for any drawing tutor.
- **Drawing hints for this unit** say *how* to draw each kind of topic (sequence
  boards for handshakes, bits boards for addresses and headers, groups for VNets
  and subnets) and what to do on the follow-ups you expect. Hints like these make
  the drawings much better than the generic paragraph alone — prefer a hint over
  hoping the model guesses.
- **`llm:`** uses GPT-6 Luna on OpenRouter, the model the board is tested with.

The full mechanics live in the tutor guide,
[`../../tutors/README.md`](../../tutors/README.md) (the `tools` section).
