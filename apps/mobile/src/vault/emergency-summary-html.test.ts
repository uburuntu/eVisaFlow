import { describe, expect, it } from "vitest";
import { emergencySummaryHtml } from "./emergency-summary-html";

describe("emergencySummaryHtml", () => {
  it("escapes user and result text and includes the required warnings", () => {
    const html = emergencySummaryHtml(
      [
        {
          profile: {
            id: "1f8f9e99-f0ea-4591-a745-aabf871febc1",
            displayName: '<script>alert("name")</script>',
            applicant: {
              identityDocument: { type: "passport", number: "SECRET123" },
              dateOfBirth: "1980-03-31",
            },
            preferredTwoFactorMethod: "sms",
            authorityBasis: "self",
            attestedAt: "2027-01-20T10:00:00.000Z",
            termsVersion: "2026-08-01",
            createdAt: "2027-01-20T10:00:00.000Z",
            updatedAt: "2027-01-20T10:00:00.000Z",
          },
          result: {
            id: "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b",
            runId: "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b",
            profileId: "1f8f9e99-f0ea-4591-a745-aabf871febc1",
            purpose: "right_to_work",
            shareCode: "ABC <23 XYZ",
            validUntil: "2027-03-31",
            generatedAt: "2027-01-20T10:00:00.000Z",
            savedAt: "2027-01-20T10:01:00.000Z",
            artifacts: [],
          },
        },
      ],
      "2027-01-20T11:00:00.000Z"
    );

    expect(html).toContain("&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;");
    expect(html).toContain("ABC &lt;23 XYZ");
    expect(html).not.toContain("SECRET123");
    expect(html).not.toContain("1980-03-31");
    expect(html).toContain("not a live UKVI check");
    expect(html).toContain("official GOV.UK eVisa and share-code service is free");
  });
});
