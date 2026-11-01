// The subset of Chromium's extension API schema that argument validation reads.
export interface ArgSpec {
  type?: string;
  $ref?: string;
  choices?: ArgSpec[];
  properties?: Record<string, ArgSpec>;
  additionalProperties?: ArgSpec;
  ignoreAdditionalProperties?: boolean;
  items?: ArgSpec;
  enum?: string[];
  optional?: boolean;
  name?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  isInstanceOf?: string;
  preserveNull?: boolean;
}

export interface ApiSchemas {
  functions: Record<string, ArgSpec[]>;
  types: Record<string, ArgSpec>;
}
