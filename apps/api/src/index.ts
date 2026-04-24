import cluster from "node:cluster";
import os from "node:os";

if (cluster.isPrimary) {
    for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
} else {
    await import("./server");
}
