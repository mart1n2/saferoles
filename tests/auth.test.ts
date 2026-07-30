import assert from "node:assert/strict";
import test from "node:test";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  chatGPTUserFromHeaders,
} from "../app/chatgpt-auth";

const EMAIL_HEADER = "oai-authenticated-user-email";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";

test("the trusted email is normalized into the persistence identity", () => {
  const headers = new Headers({
    [EMAIL_HEADER]: "  Reviewer@Example.Test  ",
    [NAME_HEADER]: "Mart%C3%ADn%20Reviewer",
    [NAME_ENCODING_HEADER]: "percent-encoded-utf-8",
  });

  assert.deepEqual(chatGPTUserFromHeaders(headers), {
    displayName: "Martín Reviewer",
    email: "reviewer@example.test",
    fullName: "Martín Reviewer",
  });
});

test("a missing or malformed authenticated email is rejected", () => {
  const invalidEmails = [
    null,
    "",
    "not-an-email",
    "two words@example.test",
    `reviewer\u0000@example.test`,
    `${"a".repeat(310)}@example.test`,
  ];

  for (const email of invalidEmails) {
    const headers = {
      get(name: string): string | null {
        return name === EMAIL_HEADER ? email : null;
      },
    };
    assert.equal(
      chatGPTUserFromHeaders(headers),
      null,
      `unexpected identity for ${JSON.stringify(email)}`,
    );
  }
});

test("an untrusted or malformed full name falls back to the email", () => {
  const wrongEncoding = new Headers({
    [EMAIL_HEADER]: "reviewer@example.test",
    [NAME_HEADER]: "Reviewer%20Name",
    [NAME_ENCODING_HEADER]: "plain-text",
  });
  const malformedEncoding = new Headers({
    [EMAIL_HEADER]: "reviewer@example.test",
    [NAME_HEADER]: "%E0%A4%A",
    [NAME_ENCODING_HEADER]: "percent-encoded-utf-8",
  });

  for (const headers of [wrongEncoding, malformedEncoding]) {
    assert.deepEqual(chatGPTUserFromHeaders(headers), {
      displayName: "reviewer@example.test",
      email: "reviewer@example.test",
      fullName: null,
    });
  }
});

test("sign-in return paths stay relative and avoid auth loops", () => {
  assert.equal(
    chatGPTSignInPath("/roles?chainId=1#review"),
    "/signin-with-chatgpt?return_to=%2Froles%3FchainId%3D1%23review",
  );

  for (const unsafe of [
    "https://attacker.example/",
    "//attacker.example/",
    "/\\attacker.example/",
    "/signin-with-chatgpt",
    "/signout-with-chatgpt?again=1",
    "/callback#repeat",
  ]) {
    assert.equal(
      chatGPTSignInPath(unsafe),
      "/signin-with-chatgpt?return_to=%2F",
    );
  }

  assert.equal(chatGPTSignOutPath(), "/signout-with-chatgpt?return_to=%2F");
  assert.equal(
    chatGPTSignOutPath("https://attacker.example/"),
    "/signout-with-chatgpt?return_to=%2F",
  );
});
