// Bytes received in chunks, read from the front without re-copying the rest,
// so a large message costs its own size rather than its size squared.
export class ByteQueue {
  private chunks: Buffer[] = [];
  private offset = 0;
  length = 0;

  push(chunk: Buffer) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peek(count: number): Buffer {
    return this.read(count, false);
  }

  take(count: number): Buffer {
    return this.read(count, true);
  }

  private read(count: number, consume: boolean): Buffer {
    if (count > this.length) throw new RangeError("not enough bytes queued");
    const parts: Buffer[] = [];
    let remaining = count;
    let index = 0;
    let offset = this.offset;
    while (remaining > 0) {
      const chunk = this.chunks[index];
      const available = chunk.length - offset;
      const used = Math.min(available, remaining);
      parts.push(chunk.subarray(offset, offset + used));
      remaining -= used;
      if (used === available) {
        index++;
        offset = 0;
      } else {
        offset += used;
      }
    }
    if (consume) {
      this.chunks.splice(0, index);
      this.offset = offset;
      this.length -= count;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }
}
