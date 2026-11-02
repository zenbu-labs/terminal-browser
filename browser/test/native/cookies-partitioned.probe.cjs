// Partitioned (CHIPS) cookies in session.cookies (patch 0033): set into a partition, read back with the partition
// key, filtered by partition, and removed per partition.
require("./harness.cjs").run("cookies-partitioned", async ({ ses, eq }) => {
  const url = "https://partitioned.test/";
  const key = { topLevelSite: "https://top.test" };
  await ses.cookies.set({ url, name: "plain", value: "u", secure: true, sameSite: "no_restriction" });
  await ses.cookies.set({ url, name: "chip", value: "1", secure: true, sameSite: "no_restriction", partitionKey: key });
  await ses.cookies.set({ url, name: "chip", value: "2", secure: true, sameSite: "no_restriction", partitionKey: { topLevelSite: "https://other.test" } });

  const names = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).sort();
  eq(names(await ses.cookies.get({ url })), ["chip=1", "chip=2", "plain=u"], "every cookie without a partition filter");
  eq(names(await ses.cookies.get({ url, partitionKey: null })), ["plain=u"], "unpartitioned only");
  const [chip] = await ses.cookies.get({ url, name: "chip", partitionKey: key });
  eq(chip?.value, "1", "the cookie of one partition");
  eq(chip?.partitionKey, { topLevelSite: "https://top.test", hasCrossSiteAncestor: true }, "its partition key");

  await ses.cookies.remove(url, "chip", key);
  eq(names(await ses.cookies.get({ url })), ["chip=2", "plain=u"], "after removing one partition's cookie");
  await ses.cookies.remove(url, "plain", null);
  eq(names(await ses.cookies.get({ url })), ["chip=2"], "after removing the unpartitioned cookie");
});
