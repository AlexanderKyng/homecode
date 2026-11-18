interface Uint8ArrayConstructor {
  fromBase64(value: string): Uint8Array
  fromHex(value: string): Uint8Array
}

interface Uint8Array {
  toBase64(): string
  toHex(): string
}

interface RegExpConstructor {
  escape(value: string): string
}
