import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AccountSelect, { type AccountOption } from "../components/account-select";

const accounts: AccountOption[] = [
  { id: "ig", label: "@posera_app", username: "posera_app", externalId: "1", platform: "INSTAGRAM" },
  { id: "yt", label: "Zee Posing", username: "Zee Posing", externalId: "2", platform: "YOUTUBE" },
];

function render() {
  return renderToStaticMarkup(
    createElement(AccountSelect, { accounts, value: "ig", onChange: () => {}, includeAll: false })
  );
}

describe("AccountSelect", () => {
  // A workspace can hold accounts on several platforms, and a YouTube channel
  // title is not a handle, so the name alone does not say where it lives.
  it("names each account's platform", () => {
    const html = render();
    expect(html).toContain("@posera_app · Instagram");
    expect(html).toContain("Zee Posing · YouTube");
  });
});
