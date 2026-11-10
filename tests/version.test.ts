import test from "node:test";
import assert from "node:assert/strict";
import { channelVersion, compareVersions, defaultChannel, isNewer, offerFor } from "../shared/version";

test("versions: semver order including prereleases", () => {
  const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.4.0-beta.2", "1.4.0-beta.10", "1.4.0", "2.0.0-beta.0", "2.0.0"];
  const shuffled = [...sorted].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), sorted);
  assert.ok(compareVersions("1.4.0-beta.10", "1.4.0-beta.9") > 0, "numeric, not lexical");
  assert.equal(compareVersions("v1.2.3", "1.2.3+build.7"), 0);
  assert.ok(compareVersions("garbage", "0.0.1") < 0);
});

test("only newer: equal and older versions are never offered", () => {
  assert.ok(isNewer("1.4.0-beta.14", "1.4.0-beta.13"));
  assert.ok(!isNewer("1.4.0-beta.13", "1.4.0-beta.13"));
  assert.ok(!isNewer("1.0.1", "1.4.0-beta.13"));
  const tags = { latest: "1.0.1", beta: "1.4.0-beta.13" };
  assert.deepEqual(offerFor("1.4.0-beta.13", "beta", tags), { kind: "current", version: "1.4.0-beta.13" });
  assert.deepEqual(offerFor("1.4.0-beta.12", "beta", tags), { kind: "update", version: "1.4.0-beta.13" });
  assert.deepEqual(offerFor("1.4.0-beta.14", "beta", tags), { kind: "behind", version: "1.4.0-beta.13" });
});

test("channels: default follows the install; Stable never assumes a stable newer than a beta exists", () => {
  assert.equal(defaultChannel("1.4.0-beta.13"), "beta");
  assert.equal(defaultChannel("1.0.1"), "stable");
  const today = { latest: "1.0.1", beta: "1.4.0-beta.13" };
  assert.deepEqual(offerFor("1.4.0-beta.13", "stable", today), { kind: "behind", version: "1.0.1" }, "a beta user on Stable waits, no downgrade");
  assert.deepEqual(offerFor("1.0.0", "stable", today), { kind: "update", version: "1.0.1" });
  assert.deepEqual(offerFor("1.0.0", "stable", { beta: "1.4.0-beta.13" }), { kind: "none" }, "no latest tag at all");
  assert.equal(channelVersion("stable", { latest: "2.0.0-beta.1" }), null, "a prerelease under latest is not stable");
});

test("channels: Beta takes the newer of beta and latest; tags pointing at unlisted versions are ignored", () => {
  assert.equal(channelVersion("beta", { latest: "1.4.0", beta: "1.4.0-beta.20" }), "1.4.0");
  assert.equal(channelVersion("beta", { latest: "1.0.1", beta: "1.4.0-beta.13" }), "1.4.0-beta.13");
  assert.equal(channelVersion("beta", { latest: "1.0.1", beta: "1.4.0-beta.14" }, ["1.0.1", "1.4.0-beta.13"]), "1.0.1");
  assert.equal(channelVersion("beta", { beta: "not-a-version" }), null);
});
