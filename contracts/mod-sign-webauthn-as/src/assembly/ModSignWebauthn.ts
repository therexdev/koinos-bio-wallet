import { StringBytes, System, Storage, Base58, Base64, Arrays, Protobuf, authority } from "@koinos/sdk-as";
import { modsignwebauthn } from "./proto/modsignwebauthn";
import { ModSign, modsign, MODULE_SIGN_TYPE_ID } from "@veive-io/mod-sign-as";
import { base64urlToBase64, extractMsg, extractPublicKey, extractSignature, getValueFromJSON } from "./utils";
import { VERIFIER_CONTRACT_ID } from "./Constants";
import { verifier, IVerifier } from "@veive-io/verifier-p256";
import UserStorage from "./UserStorage";

const CREDENTIAL_STORAGE_SPACE_ID = 1;
const SIGNATURE_PREFIX = [0xFF, 0x02];

export class ModSignWebauthn extends ModSign {
  callArgs: System.getArgumentsReturn | null;

  contractId: Uint8Array = System.getContractId();
  credential_storage: UserStorage = new UserStorage(CREDENTIAL_STORAGE_SPACE_ID, CREDENTIAL_STORAGE_SPACE_ID+1, 100);

  credentials(user: Uint8Array): Storage.Map<Uint8Array, modsignwebauthn.credential> {
    const space_id = this.credential_storage.get_space_id(user);
    return new Storage.Map(
      this.contractId,
      space_id,
      modsignwebauthn.credential.decode,
      modsignwebauthn.credential.encode,
      () => new modsignwebauthn.credential()
    );
  }

  credential_address: Storage.Map<string,modsignwebauthn.address> = new Storage.Map(
    this.contractId,
    0,
    modsignwebauthn.address.decode,
    modsignwebauthn.address.encode,
    () => new modsignwebauthn.address()
  );

  /**
   * @external
   */
  register(args: modsignwebauthn.register_arguments): void {
    const isAuthorized = System.checkAuthority(authority.authorization_type.contract_call, args.user!);
    System.require(isAuthorized, `not authorized by the account`);

    const credential = args.credential!;
    const credential_id = credential.credential_id!;

    credential.created_at = System.getBlockField("header.timestamp")!.uint64_value;

    const credential_id_bytes = StringBytes.stringToBytes(credential_id);
    this.credentials(args.user!).put(credential_id_bytes, credential);

    const address = new modsignwebauthn.address(args.user!);
    this.credential_address.put(credential_id, address);
  }

  /**
   * @external
   */
  unregister(args: modsignwebauthn.unregister_arguments): void {
    const isAuthorized = System.checkAuthority(authority.authorization_type.contract_call, args.user!);
    System.require(isAuthorized, `not authorized by the account`);

    const credential_id = args.credential_id!;
    const credential_id_bytes = StringBytes.stringToBytes(credential_id);
    this.credentials(args.user!).remove(credential_id_bytes);
    this.credential_address.remove(credential_id);
  }

  /**
   * @external
   */
  is_valid_signature(args: modsign.is_valid_signature_args): modsign.is_valid_signature_result {
    const result = new modsign.is_valid_signature_result(false);
    const tx_signature_prefixed = args.signature!

    // Check if the signature is webauthN signature by checking prefix
    if (tx_signature_prefixed[0] == SIGNATURE_PREFIX[0] && tx_signature_prefixed[1] == SIGNATURE_PREFIX[1]) {
      const tx_signature = tx_signature_prefixed.subarray(2);
      const tx_id = args.tx_id!;

      const tx_signature_decoded = Protobuf.decode<modsignwebauthn.authentication_data>(tx_signature, modsignwebauthn.authentication_data.decode);
      const credential_id = tx_signature_decoded.credential_id!;
      const signature = tx_signature_decoded.signature!;
      const authenticator_data = tx_signature_decoded.authenticator_data!;
      const client_data = tx_signature_decoded.client_data!;

      const client_data_decoded = StringBytes.bytesToString(client_data);

      const challenge_base64url = getValueFromJSON(client_data_decoded, "challenge");
      const challenge_base64 = base64urlToBase64(challenge_base64url!);
      const tx_id_str = Arrays.toHexString(tx_id);
      const tx_id_base64 = Base64.encode(StringBytes.stringToBytes(tx_id_str));
      //let origin = getValueFromJSON(client_data_decoded, "origin");
      //let crossOrigin = getValueFromJSON(client_data_decoded, "crossOrigin");

      // search for registered credential
      const credential_id_bytes = StringBytes.stringToBytes(credential_id);
      const credential = this.credentials(args.sender!).get(credential_id_bytes);
      if (credential == null || credential.public_key == null) {
        System.log(`[mod-sign-webauthn] credential not registered`);
        return result;
      }

      const t_public_key = extractPublicKey(credential.public_key!);
      const t_signature = extractSignature(signature);
      const t_msg = extractMsg(authenticator_data, client_data);

      // verify p256 signature
      const verifierContract = new IVerifier(Base58.decode(VERIFIER_CONTRACT_ID));
      const verify = verifierContract.verify(new verifier.verify_arguments(t_signature, t_public_key, t_msg)).value;
      if (verify != 1) {
        System.log(`[mod-sign-webauthn] invalid signature`);
        return result;
      }

      if (!Arrays.equal(Base64.decode(tx_id_base64), Base64.decode(challenge_base64))) {
        System.log(`[mod-sign-webauthn] txId mismatch [tx_id: ${tx_id_base64}] [challenge: ${challenge_base64}]`);
        return result;
      }

      // TODO attivare in produzione
      /*
      if (VEIVE_ORIGIN != origin) {
        System.log(`[mod-sign-webauthn] origin mismatch [origin: ${origin}] [VEIVE_ORIGIN: ${VEIVE_ORIGIN}]`);
        return result;
      }
      */

      // TODO attivare in produzione
      /*
      if ("false" != crossOrigin) {
        System.log(`[mod-sign-webauthn] crossOrigin not match [crossOrigin: ${crossOrigin}] [VEIVE_CROSSORIGIN: false]`);
        return result;
      }
      */

      System.log(`[mod-sign-webauthn] valid signature found`);
      result.value = true;
    }

    return result;
  }

  /**
   * Get credential pairs
   *
   * @external
   * @readonly
   * @param args
   * @returns
   */
  get_credentials(args: modsignwebauthn.get_credentials_args): modsignwebauthn.get_credentials_result {
    const res = new modsignwebauthn.get_credentials_result();
    res.value = [];

    const credentialDataKeys = this.credentials(args.user!).getManyKeys(new Uint8Array(0));

    for (let i = 0; i < credentialDataKeys.length; i++) {
      const credential_key = credentialDataKeys[i];
      const credential = this.credentials(args.user!).get(credential_key)!;
      res.value.push(credential);
    }
    
    return res;
  }

  /**
   * Get address by credential_id
   * 
   * @external
   * @readonly
   */
  get_address_by_credential_id(args: modsignwebauthn.get_address_by_credential_id_args): modsignwebauthn.address {
    const address = this.credential_address.get(args.credential_id!);
    if (!address) {
      System.fail(`[mod-sign-webauthn] credential not found`);
    }

    return address!;
  }

  /**
  * @external
  */
  on_install(args: modsign.on_install_args): void {
    System.log('[mod-sign-webauthn] called on_install');
  }

  /**
   * @external
   * @readonly
   */
  manifest(): modsign.manifest {
    const result = new modsign.manifest();
    result.name = "WebauthN signature";
    result.description = "Validate WebauthN (passkey) signatures";
    result.type_id = MODULE_SIGN_TYPE_ID;
    result.version = "2.0.0";
    return result;
  }
}