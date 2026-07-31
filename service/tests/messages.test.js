import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "../dist/utils/messages.js";

test("escapeHtml protects Telegram HTML text", () => {
  assert.equal(
    escapeHtml('Family <Admin> & "Owner"'),
    'Family &lt;Admin&gt; &amp; "Owner"'
  );
});
