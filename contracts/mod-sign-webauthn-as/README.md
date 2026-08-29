# **Mod Sign Webauthn**

## **Overview**

`ModSignWebauthn` is a module within the Veive protocol that introduces the WebAuthn standard for signing transactions. WebAuthn, part of the FIDO2 project, enables strong authentication using public key cryptography. This module allows users to register their devices and authenticate using passkeys, enhancing security and usability.

Full documentation: https://docs.veive.io/veive-docs/framework/core-modules/mod-sign-webauthn

## **Usage**

### **Installation**

To install the `ModSignWebauthn` module, first ensure that the Veive protocol is set up on your Koinos blockchain environment. Install the module using yarn:

```bash
yarn add @veive-io/mod-sign-webauthn-as
```

Deploy the module contract on the Koinos blockchain and install it on the desired account using the `install_module` method provided by the Veive account interface. The `on_install` method initializes necessary settings, including the account ID.

### **Scripts**

#### Build

To compile the package, run:

```bash
yarn build
```

#### Dist

To create a distribution, run:

```bash
yarn dist
```

#### Test

To test the package, use:

```bash
yarn jest
```

## **Contributing**

Contributions are welcome! Please open an issue or submit a pull request on the [GitHub repository](https://github.com/veiveprotocol).

## **License**

This project is licensed under the MIT License. See the LICENSE file for details.
