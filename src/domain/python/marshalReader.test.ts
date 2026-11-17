import { expect, it } from "vitest";

import {
  MarshalDefectError,
  MarshalReader,
  smallBitLength,
  type MarshalBytes,
  type MarshalDefect,
  type MarshalInt,
  type MarshalLimitExceeded,
  type MarshalLimits,
  type MarshalList,
  type MarshalString,
  type MarshalTuple,
} from "./marshalReader.js";

type TestValue =
  | MarshalInt
  | MarshalBytes
  | MarshalString
  | MarshalTuple<TestValue>
  | MarshalList<TestValue>;

/** A budget refusal, kept apart from the reader's format defects. */
class LimitRefusal {
  constructor(readonly exceeded: MarshalLimitExceeded) {}
}

class TestReader extends MarshalReader<TestValue> {
  constructor(
    bytes: Buffer,
    publishContainers: "before-items" | "after-items" = "after-items",
    limits?: Partial<MarshalLimits>,
  ) {
    super(bytes, {
      format: "marshal-test",
      limits: {
        maxObjects: 8,
        maxDepth: 3,
        maxStringBytes: 32,
        maxSequence: 3,
        maxLongDigits: 3,
        ...limits,
      },
      previewLimit: 3,
      publishContainers,
    });
  }

  protected override wrap(value: TestValue): TestValue {
    return value;
  }

  protected override limitExceeded(exceeded: MarshalLimitExceeded): never {
    throw new LimitRefusal(exceeded);
  }
}

// CPython marshal type codes without FLAG_REF.
const TYPE_INT = 0x69;
const TYPE_LONG = 0x6c;
const TYPE_BYTES = 0x73;
const TYPE_REF = 0x72;
const TYPE_TUPLE = 0x28;
const TYPE_LIST = 0x5b;
const TYPE_UNICODE = 0x75;
const TYPE_SMALL_TUPLE = 0x29;
const TYPE_SHORT_ASCII = 0x7a;
const TYPE_SHORT_ASCII_INTERNED = 0x5a;
const FLAG_REF = 0x80;

const u8 = (...bytes: number[]): Buffer => Buffer.from(bytes);
const i32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
};
const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

const intValue = (value: number): Buffer => cat(u8(TYPE_INT), i32(value));
const shortAscii = (text: string): Buffer =>
  cat(u8(TYPE_SHORT_ASCII), u8(text.length), Buffer.from(text, "latin1"));

const readOne = (
  stream: Buffer,
  publishContainers: "before-items" | "after-items" = "after-items",
  limits?: Partial<MarshalLimits>,
): TestValue => new TestReader(stream, publishContainers, limits).readObject(0);

const defectOf = (read: () => unknown): MarshalDefect => {
  try {
    read();
  } catch (error) {
    if (error instanceof MarshalDefectError) return error.defect;
    throw error;
  }
  throw new Error("expected the stream to fail with a marshal defect");
};

const limitOf = (read: () => unknown): MarshalLimitExceeded => {
  try {
    read();
  } catch (error) {
    if (error instanceof LimitRefusal) return error.exceeded;
    throw error;
  }
  throw new Error("expected the stream to fail with a budget refusal");
};

it.each([
  [0n, 0],
  [1n, 1],
  [-1n, 1],
  [255n, 8],
  [-256n, 9],
  [2n ** 32n, 33],
])("measures smallBitLength(%i) as %i bits", (value, bits) => {
  expect(smallBitLength(value)).toBe(bits);
});

it.each([
  [0, 0n, 0],
  [12, 12n, 4],
  [-12, -12n, 4],
  [0x7fffffff, 0x7fffffffn, 31],
  [-0x80000000, -0x80000000n, 32],
])("reads TYPE_INT %i with its magnitude bit length", (input, value, bits) => {
  expect(readOne(cat(u8(TYPE_INT), i32(input)))).toEqual({
    kind: "int",
    value,
    bits,
  });
});

it.each([
  ["zero digits", i32(0), 0n, 0],
  ["one digit", cat(i32(1), u16(1)), 1n, 1],
  ["negative two digits", cat(i32(-2), u16(0), u16(1)), -32768n, 16],
])(
  "reads TYPE_LONG %s as a normalized magnitude",
  (_label, body, value, bits) => {
    expect(readOne(cat(u8(TYPE_LONG), body))).toEqual({
      kind: "int",
      value,
      bits,
    });
  },
);

it("reads one-byte ASCII tags as Latin-1 and re-encodes high bytes into raw", () => {
  expect(readOne(cat(u8(TYPE_SHORT_ASCII), u8(2), u8(0x61, 0xe9)))).toEqual({
    kind: "str",
    value: "a\u00e9",
    bytes: 2,
    raw: Buffer.from("a\u00e9", "utf8"),
    previewEnd: 2,
  });
  expect(
    readOne(cat(u8(TYPE_SHORT_ASCII_INTERNED), u8(2), u8(0x61, 0xe9))),
  ).toEqual(readOne(cat(u8(TYPE_SHORT_ASCII), u8(2), u8(0x61, 0xe9))));
});

it("reads TYPE_UNICODE as UTF-8 and bounds the preview prefix", () => {
  expect(readOne(cat(u8(TYPE_UNICODE), i32(4), Buffer.from("abcd")))).toEqual({
    kind: "str",
    value: "abcd",
    bytes: 4,
    raw: Buffer.from("abcd"),
    previewEnd: 3,
  });
});

it("reads TYPE_BYTES payloads", () => {
  expect(readOne(cat(u8(TYPE_BYTES), i32(3), Buffer.from([1, 2, 3])))).toEqual({
    kind: "bytes",
    value: Buffer.from([1, 2, 3]),
  });
});

it("reads tuples and lists in stream order", () => {
  expect(
    readOne(cat(u8(TYPE_SMALL_TUPLE), u8(2), intValue(7), shortAscii("x"))),
  ).toEqual({
    kind: "tuple",
    items: [
      { kind: "int", value: 7n, bits: 3 },
      {
        kind: "str",
        value: "x",
        bytes: 1,
        raw: Buffer.from("x"),
        previewEnd: 1,
      },
    ],
  });
  const nested = readOne(
    cat(
      u8(TYPE_TUPLE),
      i32(1),
      u8(TYPE_LIST),
      i32(2),
      intValue(1),
      intValue(2),
    ),
  );
  if (nested.kind !== "tuple") throw new Error("expected a tuple");
  expect(nested.items[0]).toEqual({
    kind: "list",
    items: [
      { kind: "int", value: 1n, bits: 1 },
      { kind: "int", value: 2n, bits: 2 },
    ],
  });
});

it("returns the identical object for TYPE_REF and charges one object per read", () => {
  const reader = new TestReader(
    cat(
      u8(TYPE_SHORT_ASCII | FLAG_REF),
      u8(1),
      Buffer.from("a"),
      u8(TYPE_REF),
      u32(0),
    ),
  );
  const first = reader.readObject(0);
  const second = reader.readObject(0);
  expect(second).toBe(first);
  expect(reader.objects).toBe(2);
});

it("publishes a flagged container before its items so a self-reference resolves", () => {
  const stream = cat(
    u8(TYPE_SMALL_TUPLE | FLAG_REF),
    u8(1),
    u8(TYPE_REF),
    u32(0),
  );
  const cyclic = readOne(stream, "before-items");
  if (cyclic.kind !== "tuple") throw new Error("expected a tuple");
  expect(cyclic.items[0]).toBe(cyclic);
});

it("keeps containers unpublished until complete so a self-reference is a defect", () => {
  const stream = cat(
    u8(TYPE_SMALL_TUPLE | FLAG_REF),
    u8(1),
    u8(TYPE_REF),
    u32(0),
  );
  expect(defectOf(() => readOne(stream, "after-items"))).toBe(
    "unresolved-reference",
  );
});

it.each([
  ["an empty stream", Buffer.alloc(0), "truncated"],
  [
    "a short-ascii payload overrun",
    cat(u8(TYPE_SHORT_ASCII), u8(5), Buffer.from("ab")),
    "truncated",
  ],
  [
    "a negative string length",
    cat(u8(TYPE_BYTES), i32(-1)),
    "negative-string-length",
  ],
  [
    "a negative sequence length",
    cat(u8(TYPE_TUPLE), i32(-1)),
    "negative-sequence-length",
  ],
  ["an unsupported type", u8(0x4e), "unsupported-type"],
  ["invalid UTF-8", cat(u8(TYPE_UNICODE), i32(1), u8(0x80)), "invalid-utf8"],
  [
    "a long with a zero leading digit",
    cat(u8(TYPE_LONG), i32(1), u16(0)),
    "long-not-normalized",
  ],
  [
    "a long digit out of range",
    cat(u8(TYPE_LONG), i32(1), u16(0x8000)),
    "long-digit-range",
  ],
  ["a missing reference", cat(u8(TYPE_REF), u32(3)), "unresolved-reference"],
] as const)("rejects %s as %s", (_label, stream, defect) => {
  expect(defectOf(() => readOne(stream))).toBe(defect);
});

it("refuses an object budget overflow", () => {
  const reader = new TestReader(cat(intValue(1), intValue(2)), "after-items", {
    maxObjects: 1,
  });
  reader.readObject(0);
  expect(limitOf(() => reader.readObject(0))).toEqual({ limit: "objects" });
});

it("refuses a nesting depth beyond the budget", () => {
  expect(
    limitOf(() =>
      readOne(
        cat(
          u8(TYPE_SMALL_TUPLE),
          u8(1),
          u8(TYPE_SMALL_TUPLE),
          u8(1),
          intValue(0),
        ),
        "after-items",
        { maxDepth: 1 },
      ),
    ),
  ).toEqual({ limit: "depth" });
});

it.each([
  [
    "sequence counts",
    cat(u8(TYPE_SMALL_TUPLE), u8(4)),
    { maxSequence: 3 },
    { limit: "sequence", amount: 4 },
  ],
  [
    "string lengths",
    cat(u8(TYPE_BYTES), i32(5)),
    { maxStringBytes: 4 },
    { limit: "string-bytes", amount: 5 },
  ],
  [
    "long digit counts before any digit is read",
    cat(u8(TYPE_LONG), i32(3)),
    { maxLongDigits: 2 },
    { limit: "long-digits", amount: 3 },
  ],
  [
    "long byte widths",
    cat(u8(TYPE_LONG), i32(20), u16(1)),
    { maxLongDigits: 100, maxStringBytes: 32 },
    { limit: "long-bytes", amount: 40 },
  ],
] as const)(
  "refuses %s against the budget",
  (_label, stream, limits, exceeded) => {
    expect(limitOf(() => readOne(stream, "after-items", limits))).toEqual(
      exceeded,
    );
  },
);
