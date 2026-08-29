import { Crypto, System } from "@koinos/sdk-as";

export function concatenateBytes(bytes1: Uint8Array, bytes2: Uint8Array): Uint8Array {
    const result = new Uint8Array(bytes1.length + bytes2.length);
    result.set(bytes1, 0);
    result.set(bytes2, bytes1.length);
    return result;
}

export function getValueFromJSON(jsonStr: string, key: string): string | null {
    let keyStr = '"' + key + '":';
    let startIndex = jsonStr.indexOf(keyStr);

    if (startIndex == -1) {
        // La chiave non è stata trovata
        return null;
    }

    startIndex += keyStr.length;
    let firstChar = jsonStr.charAt(startIndex);

    if (firstChar == '"') {
        // Il valore è una stringa
        startIndex += 1;
        let endIndex = jsonStr.indexOf('"', startIndex);

        if (endIndex == -1) {
            // Il valore della chiave non è stato trovato
            return null;
        }

        return jsonStr.substring(startIndex, endIndex);
    } else if (jsonStr.substring(startIndex, startIndex + 4) == "true") {
        // Il valore è booleano true
        return "true";
    } else if (jsonStr.substring(startIndex, startIndex + 5) == "false") {
        // Il valore è booleano false
        return "false";
    } else {
        // Tipo di valore non supportato
        return null;
    }
}

export function base64urlToBase64(base64urlString: string): string {
    let base64String = "";

    // Loop through each character in the base64urlString
    for (let i = 0; i < base64urlString.length; i++) {
        let char = base64urlString.charAt(i);

        // Replace '-' with '+', '_' with '/'
        if (char === '-') {
            base64String += '+';
        } else if (char === '_') {
            base64String += '/';
        } else {
            base64String += char;
        }
    }

    // Calculate necessary padding '='
    const paddingLength = base64String.length % 4;
    if (paddingLength !== 0) {
        base64String += '='.repeat(4 - paddingLength);
    }

    return base64String;
}


/**
 * Get message for p256 verification
 * uthentiator_data + sha256(client_data)
 *
 * @param authenticator_data
 * @param client_data
 * @returns
 */
export function extractMsg(authenticator_data: Uint8Array, client_data: Uint8Array): Uint8Array {
    const clientHash = System.hash(Crypto.multicodec.sha2_256, client_data);
    let mh = new Crypto.Multihash();
    mh.deserialize(clientHash!);
    return this.concatenateBytes(authenticator_data, mh.digest);
}

/**
 * Convert signature from ASN.1 sequence to "raw" format
 *
 * @param signature
 * @returns
 */
export function extractSignature(signature: Uint8Array): Uint8Array {
    const rStart = signature[4] === 0 ? 5 : 4;
    const rEnd = rStart + 32;
    const sStart = signature[rEnd + 2] === 0 ? rEnd + 3 : rEnd + 2;
    const r = signature.slice(rStart, rEnd);
    const s = signature.slice(sStart);
    return this.concatenateBytes(r, s);
}

/**
 * Convert public key from COSE format to "raw" format
 * constant byte + latest 64 bytes
 *
 * @param public_key
 * @returns
 */
export function extractPublicKey(public_key: Uint8Array): Uint8Array {
    const public_key64bytes = public_key.slice(public_key.length - 64);
    const public_key65bytes = new Uint8Array(65);
    public_key65bytes.set([4], 0);
    public_key65bytes.set(public_key64bytes, 1);
    return public_key65bytes;
}