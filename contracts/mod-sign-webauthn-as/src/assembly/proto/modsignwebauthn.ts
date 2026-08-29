import { Writer, Reader } from "as-proto";

export namespace modsignwebauthn {
  export class credential {
    static encode(message: credential, writer: Writer): void {
      const unique_name_credential_id = message.credential_id;
      if (unique_name_credential_id !== null) {
        writer.uint32(10);
        writer.string(unique_name_credential_id);
      }

      const unique_name_public_key = message.public_key;
      if (unique_name_public_key !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_public_key);
      }

      const unique_name_name = message.name;
      if (unique_name_name !== null) {
        writer.uint32(26);
        writer.string(unique_name_name);
      }

      if (message.created_at != 0) {
        writer.uint32(32);
        writer.uint64(message.created_at);
      }
    }

    static decode(reader: Reader, length: i32): credential {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new credential();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.credential_id = reader.string();
            break;

          case 2:
            message.public_key = reader.bytes();
            break;

          case 3:
            message.name = reader.string();
            break;

          case 4:
            message.created_at = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    credential_id: string | null;
    public_key: Uint8Array | null;
    name: string | null;
    created_at: u64;

    constructor(
      credential_id: string | null = null,
      public_key: Uint8Array | null = null,
      name: string | null = null,
      created_at: u64 = 0
    ) {
      this.credential_id = credential_id;
      this.public_key = public_key;
      this.name = name;
      this.created_at = created_at;
    }
  }

  export class register_arguments {
    static encode(message: register_arguments, writer: Writer): void {
      const unique_name_user = message.user;
      if (unique_name_user !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_user);
      }

      const unique_name_credential = message.credential;
      if (unique_name_credential !== null) {
        writer.uint32(18);
        writer.fork();
        credential.encode(unique_name_credential, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): register_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new register_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.user = reader.bytes();
            break;

          case 2:
            message.credential = credential.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    user: Uint8Array | null;
    credential: credential | null;

    constructor(
      user: Uint8Array | null = null,
      credential: credential | null = null
    ) {
      this.user = user;
      this.credential = credential;
    }
  }

  export class unregister_arguments {
    static encode(message: unregister_arguments, writer: Writer): void {
      const unique_name_user = message.user;
      if (unique_name_user !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_user);
      }

      const unique_name_credential_id = message.credential_id;
      if (unique_name_credential_id !== null) {
        writer.uint32(18);
        writer.string(unique_name_credential_id);
      }
    }

    static decode(reader: Reader, length: i32): unregister_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new unregister_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.user = reader.bytes();
            break;

          case 2:
            message.credential_id = reader.string();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    user: Uint8Array | null;
    credential_id: string | null;

    constructor(
      user: Uint8Array | null = null,
      credential_id: string | null = null
    ) {
      this.user = user;
      this.credential_id = credential_id;
    }
  }

  export class authentication_data {
    static encode(message: authentication_data, writer: Writer): void {
      const unique_name_credential_id = message.credential_id;
      if (unique_name_credential_id !== null) {
        writer.uint32(10);
        writer.string(unique_name_credential_id);
      }

      const unique_name_signature = message.signature;
      if (unique_name_signature !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_signature);
      }

      const unique_name_authenticator_data = message.authenticator_data;
      if (unique_name_authenticator_data !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_authenticator_data);
      }

      const unique_name_client_data = message.client_data;
      if (unique_name_client_data !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_client_data);
      }
    }

    static decode(reader: Reader, length: i32): authentication_data {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new authentication_data();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.credential_id = reader.string();
            break;

          case 2:
            message.signature = reader.bytes();
            break;

          case 3:
            message.authenticator_data = reader.bytes();
            break;

          case 4:
            message.client_data = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    credential_id: string | null;
    signature: Uint8Array | null;
    authenticator_data: Uint8Array | null;
    client_data: Uint8Array | null;

    constructor(
      credential_id: string | null = null,
      signature: Uint8Array | null = null,
      authenticator_data: Uint8Array | null = null,
      client_data: Uint8Array | null = null
    ) {
      this.credential_id = credential_id;
      this.signature = signature;
      this.authenticator_data = authenticator_data;
      this.client_data = client_data;
    }
  }

  export class get_credentials_args {
    static encode(message: get_credentials_args, writer: Writer): void {
      const unique_name_user = message.user;
      if (unique_name_user !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_user);
      }
    }

    static decode(reader: Reader, length: i32): get_credentials_args {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_credentials_args();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.user = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    user: Uint8Array | null;

    constructor(user: Uint8Array | null = null) {
      this.user = user;
    }
  }

  export class get_credentials_result {
    static encode(message: get_credentials_result, writer: Writer): void {
      const unique_name_value = message.value;
      for (let i = 0; i < unique_name_value.length; ++i) {
        writer.uint32(10);
        writer.fork();
        credential.encode(unique_name_value[i], writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): get_credentials_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_credentials_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value.push(credential.decode(reader, reader.uint32()));
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: Array<credential>;

    constructor(value: Array<credential> = []) {
      this.value = value;
    }
  }

  export class get_address_by_credential_id_args {
    static encode(
      message: get_address_by_credential_id_args,
      writer: Writer
    ): void {
      const unique_name_credential_id = message.credential_id;
      if (unique_name_credential_id !== null) {
        writer.uint32(10);
        writer.string(unique_name_credential_id);
      }
    }

    static decode(
      reader: Reader,
      length: i32
    ): get_address_by_credential_id_args {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_address_by_credential_id_args();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.credential_id = reader.string();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    credential_id: string | null;

    constructor(credential_id: string | null = null) {
      this.credential_id = credential_id;
    }
  }

  export class address {
    static encode(message: address, writer: Writer): void {
      const unique_name_value = message.value;
      if (unique_name_value !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_value);
      }
    }

    static decode(reader: Reader, length: i32): address {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new address();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: Uint8Array | null;

    constructor(value: Uint8Array | null = null) {
      this.value = value;
    }
  }
}
