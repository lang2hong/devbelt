/**
 * 仅内存 DEK 会话（P6-S5b）：不持久化（无 sessionStorage/localStorage）；clear() 清零。
 * 登出/会话失效必须调用 clear。
 */
export class DekSession {
  private dek?: Uint8Array;

  set(dek: Uint8Array): void {
    if (dek.length !== 32) throw new Error('DEK must be 32 bytes');
    this.clear();
    const copy = new Uint8Array(32);
    copy.set(dek);
    this.dek = copy;
  }

  get(): Uint8Array | undefined {
    return this.dek;
  }

  get isUnlocked(): boolean {
    return this.dek !== undefined;
  }

  clear(): void {
    this.dek?.fill(0);
    this.dek = undefined;
  }
}
