import { describe, expect, it } from "vitest";
import { classifyFailure, extractMessage, scrub } from "../../src/federation/classify.ts";

type Row = [string, Parameters<typeof classifyFailure>[0], string, string, boolean];

describe("classifyFailure", () => {
  const cases: Row[] = [
    // infrastructure reported as HTTP 400 by the engine
    ["stopped SparkContext", { status: 400, body: '{"msg":"Cannot call methods on a stopped SparkContext."}' }, "UNAVAILABLE", "SPARK_CONTEXT_STOPPED", true],
    ["SparkContext shut down", { status: 400, body: "SparkContext was shut down" }, "UNAVAILABLE", "SPARK_CONTEXT_STOPPED", true],
    ["ResultSet null", { status: 400, body: '{"msg":"Could not create ResultSet: null"}' }, "UNAVAILABLE", "RESULTSET_NOT_CREATED", true],
    ["thrift transport", { status: 400, body: "org.apache.thrift.transport.TTransportException: java.net.SocketException: Broken pipe" }, "UNAVAILABLE", "THRIFT_TRANSPORT", true],
    ["thrift protocol", { status: 500, body: "TProtocolException: Required field missing" }, "UNAVAILABLE", "THRIFT_TRANSPORT", true],
    ["out of memory", { status: 400, body: "java.lang.OutOfMemoryError: Java heap space" }, "UNAVAILABLE", "OUT_OF_MEMORY", true],
    ["connection reset text", { status: 502, body: "Connection reset by peer" }, "UNAVAILABLE", "CONNECTION_LOST", true],
    ["query timed out text", { status: 400, body: "Query timed out after 60s" }, "UNAVAILABLE", "TIMEOUT", true],
    // plain HTTP statuses
    ["500", { status: 500, body: "boom" }, "UNAVAILABLE", "HTTP_500", true],
    ["502", { status: 502, body: "" }, "UNAVAILABLE", "HTTP_502", true],
    ["503", { status: 503, body: "" }, "UNAVAILABLE", "HTTP_503", true],
    ["429", { status: 429, body: "" }, "UNAVAILABLE", "HTTP_429", true],
    ["408", { status: 408, body: "" }, "UNAVAILABLE", "HTTP_408", true],
    // access
    ["401 missing header", { status: 401, body: "Invalid value for: header Authorization (missing)" }, "FORBIDDEN", "BAD_CREDENTIAL", false],
    ["401 plain", { status: 401, body: "" }, "FORBIDDEN", "HTTP_401", false],
    ["403", { status: 403, body: "forbidden" }, "FORBIDDEN", "ACCESS_DENIED", false],
    ["wrong key is HTTP 400 Not Allowed (observed 2026-10-27)", { status: 400, body: '{"msg":"Not Allowed"}' }, "FORBIDDEN", "NOT_ALLOWED", false],
    ["USL access", { status: 400, body: '{"msg":"User does not have access to USL lightning.metastore.n.u"}' }, "FORBIDDEN", "NO_USL_ACCESS", false],
    ["USL access at HTTP 500", { status: 500, body: "does not have access to USL x" }, "FORBIDDEN", "NO_USL_ACCESS", false],
    ["no permission", { status: 400, body: "The user has no permission on table hospital.requirements" }, "FORBIDDEN", "NO_ACCESS", false],
    ["admin only", { status: 400, body: "COMPILE USL is for Administrators only" }, "FORBIDDEN", "ADMIN_ONLY", false],
    // the refusal the engine gives a non-administrator who sends COMPILE USL (observed 2026-10-27, infra/zetaris gates, HTTP 400)
    ["not permitted, as the engine words it", { status: 400, body: '{"msg":"User is not permitted to run this command"}' }, "FORBIDDEN", "NOT_PERMITTED", false],
    ["not permitted at HTTP 500", { status: 500, body: "User is not permitted to run this command" }, "FORBIDDEN", "NOT_PERMITTED", false],
    ["not permitted, plain case variant", { status: 400, body: "you are NOT PERMITTED to run this" }, "FORBIDDEN", "NOT_PERMITTED", false],
    // the request itself
    ["parse error", { status: 400, body: "org.apache.spark.sql.catalyst.parser.ParseException: mismatched input 'FORM'" }, "INVALID", "SYNTAX", false],
    ["Spark's own 'Operation not allowed' is a bad request, not an access refusal", { status: 400, body: "org.apache.spark.sql.catalyst.parser.ParseException: Operation not allowed: CREATE TEMPORARY TABLE" }, "INVALID", "SYNTAX", false],
    ["unknown table", { status: 400, body: "Table or view not found: hospital.nope" }, "INVALID", "UNRESOLVED", false],
    ["disabled statement", { status: 400, body: "SHOW NAMESPACES / SHOW TABLES are disabled" }, "INVALID", "DISABLED_STATEMENT", false],
    ["404", { status: 404, body: "" }, "INVALID", "HTTP_404", false],
    ["unrecognised 400", { status: 400, body: "queryId and source are required" }, "INVALID", "HTTP_400", false],
    // no response at all
    ["timeout flag", { timedOut: true }, "UNAVAILABLE", "TIMEOUT", true],
    ["connection refused", { code: "ECONNREFUSED" }, "UNAVAILABLE", "CONNECTION_REFUSED", true],
    ["reset", { code: "ECONNRESET" }, "UNAVAILABLE", "NETWORK", true],
    ["dns", { code: "ENOTFOUND" }, "UNAVAILABLE", "NETWORK", true],
    ["unknown network error", { message: "fetch failed" }, "UNAVAILABLE", "NETWORK", true],
  ];
  it.each(cases)("%s", (_name, input, failure, reason, retryable) => {
    const c = classifyFailure(input);
    expect({ failure: c.failure, reason: c.reason, retryable: c.retryable }).toEqual({ failure, reason, retryable });
  });

  it("never reads an infrastructure fault as an access refusal or as an empty answer", () => {
    for (const body of ["Cannot call methods on a stopped SparkContext.", "Could not create ResultSet: null", "TTransportException"]) {
      for (const status of [400, 500]) {
        const c = classifyFailure({ status, body });
        expect(c.failure, `${status} ${body}`).toBe("UNAVAILABLE");
      }
    }
  });
});

describe("extractMessage", () => {
  it("reads the common JSON fields and falls back to the raw text", () => {
    expect(extractMessage('{"msg":"Not Allowed"}')).toBe("Not Allowed");
    expect(extractMessage('{"error":{"message":"deep"}}')).toBe("deep");
    expect(extractMessage("plain text")).toBe("plain text");
    expect(extractMessage(undefined)).toBe("");
    expect(extractMessage("x".repeat(1000)).length).toBe(400);
  });
});

describe("scrub", () => {
  it("removes configured secrets and bearer tokens", () => {
    expect(scrub("key=abc123456789 failed", ["abc123456789"])).toBe("key=(key) failed");
    expect(scrub("Authorization: Bearer abcdefghijkl1234", [])).toBe("Authorization: Bearer (key)");
  });
  it("ignores empty or very short secrets rather than wrecking the text", () => {
    expect(scrub("ab", [""])).toBe("ab");
    expect(scrub("a b c", ["a"])).toBe("a b c");
  });
});
