import Homey from 'homey';
import type PairSession from 'homey/lib/PairSession';

module.exports = class MyDriver extends Homey.Driver {

    async onInit() {
        this.log('MyDriver has been initialized');
    }

    async onPair(session: PairSession): Promise<void> {
        // @ts-ignore
        const {CompanionLink} = await import('@basmilius/apple-companion-link');
        const {waitFor} = await import('@basmilius/utils');

        let devices: any[] = [];
        let pairingDevice: any;
        let protocol: typeof CompanionLink;
        let m1: any, m2: any, m3: any, m4: any, m5: any;

        session.setHandler('showView', async view => {
            if (view === 'discover') {
                const strategy = this.getDiscoveryStrategy();
                devices = Object.values(strategy.getDiscoveryResults());

                strategy.on('result', result => {
                    console.log(result);
                    devices.push(result);
                });

                await waitFor(1000);

                if (devices.length > 0) {
                    await session.showView('list_devices');
                }
            }

            if (view === 'authenticate') {
                if (pairingDevice === null) {
                    await session.showView('list_devices');
                    this.error('Pairing device not set');
                    return;
                }

                const device = devices.find(d => d.id === pairingDevice.data.id);

                protocol = new CompanionLink({
                    address: device.address,
                    service: {
                        port: device.port
                    }
                });

                await protocol.connect();
                await protocol.pairing.start();
                m1 = await protocol.pairing.m1();
            }
        });

        session.setHandler('list_devices', async (): Promise<any[]> => {
            return devices.map(device => ({
                name: device.name,
                data: {
                    id: device.id
                }
            }));
        });

        session.setHandler('list_devices_selection', async (devices: any[]) => {
            let device = devices.pop();

            if (device !== undefined) {
                pairingDevice = device;
            }
        });

        session.setHandler('pincode', async (code: Buffer) => {
            if (!protocol) {
                this.error('Pairing client should not be null');
                return;
            }

            if (!pairingDevice) {
                this.error('Pairing device should not be null');
                return;
            }

            this.log('Pincode submitted', code.join(''));

            m2 = await protocol.pairing.m2(m1, code.join(''));
            m3 = await protocol.pairing.m3(m2);
            m4 = await protocol.pairing.m4(m3);
            m5 = await protocol.pairing.m5(m4);

            const credentials = await protocol.pairing.m6(m4, m5);
            const device = devices.find(d => d.id === pairingDevice.data.id);

            pairingDevice.store = {};
            pairingDevice.store.id = device.id;
            pairingDevice.store.credentials = {
                accessoryIdentifier: credentials.accessoryIdentifier,
                accessoryLongTermPublicKey: credentials.accessoryLongTermPublicKey.toString('hex'),
                pairingId: credentials.pairingId.toString('hex'),
                publicKey: credentials.publicKey.toString('hex'),
                secretKey: credentials.secretKey.toString('hex')
            };

            console.log(pairingDevice);
            console.log(credentials);

            await session.showView('add_device');

            return pairingDevice;
        });

        session.setHandler('getDevice', async (): Promise<any> => {
            if (pairingDevice === null) {
                throw new Error('Pairing device not set');
            }

            return pairingDevice;
        });
    }

};
