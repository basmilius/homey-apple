export default async function (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
