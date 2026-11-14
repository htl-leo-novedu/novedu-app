import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MoodleConnection, type MoodleConnectionView } from "./moodle-connection";

// The teacher's read-only "Moodle connection" section on /settings: the three
// addresses and the public key with copy buttons, and the connection state.

const VIEW: MoodleConnectionView = {
  state: "key",
  connectedTo: null,
  toolUrl: "https://novedu.example/api/lti/launch",
  loginUrl: "https://novedu.example/api/lti/login",
  jwksUrl: "https://novedu.example/api/lti/jwks",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----",
};

test("without a key it says Moodle hand-in is not set up", async () => {
  const screen = await render(<MoodleConnection view={{ state: "no-key" }} />);
  await expect
    .element(screen.getByText("Moodle hand-in is not set up on this Novedu (no key configured)."))
    .toBeVisible();
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
});

test("with a key but no connection it lists the addresses and says what is missing", async () => {
  const screen = await render(<MoodleConnection view={VIEW} />);
  await expect
    .element(screen.getByTestId("moodle-connection-state"))
    .toHaveTextContent(/Not connected yet/);
  await expect.element(screen.getByText(VIEW.toolUrl)).toBeVisible();
  await expect.element(screen.getByText(VIEW.loginUrl)).toBeVisible();
  await expect.element(screen.getByText(VIEW.jwksUrl)).toBeVisible();
  await expect.element(screen.getByText(/Anwendername an Tool übergeben/)).toBeVisible();
});

test("connected names the Plattform-ID", async () => {
  const screen = await render(
    <MoodleConnection view={{ ...VIEW, connectedTo: "https://moodle.example.org" }} />,
  );
  await expect
    .element(screen.getByTestId("moodle-connection-state"))
    .toHaveTextContent("Connected to https://moodle.example.org.");
});

test("each copy button copies its value", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const screen = await render(<MoodleConnection view={VIEW} />);
  await screen.getByRole("button", { name: "Copy Login URL" }).click();
  expect(writeText).toHaveBeenLastCalledWith(VIEW.loginUrl);
  await screen.getByRole("button", { name: "Copy public key" }).click();
  expect(writeText).toHaveBeenLastCalledWith(VIEW.publicKeyPem);
});
