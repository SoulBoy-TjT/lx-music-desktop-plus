export const awaitProviderSettlement = async<T>(
  providerPromise: Promise<T>,
  deadlineMs: number,
  operationName: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationName} exceeded ${deadlineMs} ms`))
    }, deadlineMs)
  })
  try {
    return await Promise.race([providerPromise, deadline])
  } finally {
    clearTimeout(timer!)
  }
}
