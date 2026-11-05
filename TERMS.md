# Terms and Conditions

**Marauder Console** · Effective 1 November 2026

These terms apply to your use of Marauder Console ("the app"), its source code and its
documentation. By downloading, installing or using the app, you agree to them. If you don't agree,
don't use the app.

## 1. License

The app is released under the [MIT License](LICENSE). You may use, copy, modify, merge, publish,
distribute, sublicense and sell copies of it under those terms. These Terms and Conditions describe
how you may operate the app; they do not reduce the rights the MIT License grants you in the code.

## 2. Authorised use only

The app is a control panel and reference for ESP32 Marauder, a Wi-Fi and Bluetooth security-testing
tool. Some of its commands **transmit** (for example deauthentication, beacon and probe frames,
access-point spoofing and BLE advertisement spam) and can disrupt other devices.

- Use the app only on networks and devices that **you own or have explicit written permission to
  test.** Do not use it to access, disrupt, degrade or interfere with other people's networks,
  devices or communications.
- Transmitting on radio frequencies, intercepting traffic and accessing computer systems are
  regulated by law in most places (for example radio/spectrum rules and computer-misuse or
  unauthorised-access laws). **You are solely responsible for knowing and obeying the laws that
  apply to you.** Some actions the firmware can perform may be illegal to use against others
  regardless of intent.
- You are responsible for everything you do with the app and the board, and for any consequences.

## 3. Not affiliated

The app is an independent project. It is not made, endorsed, sponsored or supported by the ESP32
Marauder project, its maintainers, Espressif Systems, or the makers of the "Cheap Yellow Display"
board. Product and project names are used only to describe what the app works with. The firmware
and hardware have their own licenses, terms and authors; those apply to them, not to this app.

## 4. Third-party software

The app uses other software covered by its own licenses, including (bridge) FastAPI, Uvicorn,
pyserial and pyserial-asyncio-fast, and (frontend) React, Tailwind CSS, lucide-react and
shadcn/ui-style components. Those licenses apply to those components. The ESP32 Marauder firmware
on the board is a separate project with its own license and terms.

## 5. No warranty

The app is provided **"as is" and "as available"**, without warranties of any kind, express or
implied, including merchantability, fitness for a particular purpose and non-infringement. The
author does not promise that it will work with your board, be free of bugs, or keep working after
updates to the firmware, your operating system or its dependencies.

## 6. Limitation of liability

To the fullest extent the law allows, the author is not liable for any indirect, incidental,
special, consequential or punitive damages, or for any loss of data, use or profit, arising from
your use of the app or inability to use it, even if advised of the possibility — including any
damages, penalties or legal consequences that result from how you use the app or the board. Where
liability can't be excluded, it is limited to the amount you paid for the app (the app is free, so
that amount is zero).

Some places don't allow these exclusions or limits, so some of them may not apply to you. Nothing
in these terms limits rights you have under consumer law that can't be waived.

## 7. Privacy

How the app handles information is described in the [Privacy Policy](PRIVACY.md).

## 8. Changes and termination

These terms may be updated in the repository, with a new effective date. Continuing to use the app
after a change means you accept the new terms. Your permission to operate the app under section 2
ends automatically if you break these terms; the MIT License's own terms continue to govern the
code.

## 9. Contact

Questions about these terms: open an issue on the project's GitHub repository.
