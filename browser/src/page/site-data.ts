import { session } from "electron";

// mirrors how the engine names persistent partitions, since it does not export that helper
function partitionSession(partition: string | null) {
  if (!partition) return session.defaultSession;
  return session.fromPartition(
    partition.startsWith("persist:") ? partition : `persist:${partition}`,
  );
}

export async function clearSiteData(partition: string | null, origin?: string): Promise<void> {
  await partitionSession(partition).clearData(origin ? { origins: [origin] } : {});
}
