export function createReaper({ expiredSessions, releaseSession, microvms, now = () => Math.floor(Date.now() / 1000) }) {
  return async function handler() {
    const sessions = await expiredSessions(now())
    const results = { found: sessions.length, terminated: 0, deferred: 0 }
    for (const session of sessions) {
      try {
        if (session.microvmId) {
          const vm = await microvms.get({ microvmIdentifier: session.microvmId })
          if (!['TERMINATING', 'TERMINATED'].includes(vm.state)) {
            await microvms.terminate({ microvmIdentifier: session.microvmId })
          }
          results.terminated++
        }
        await releaseSession(session)
      } catch (error) {
        if (['ResourceNotFoundException', 'NotFoundException'].includes(error?.name)) {
          try {
            await releaseSession(session)
            continue
          } catch (releaseError) {
            results.deferred++
            console.warn('Expired MicroVM cleanup deferred:', releaseError.name || 'Error')
            continue
          }
        }
        results.deferred++
        console.warn('Expired MicroVM cleanup deferred:', error.name || 'Error')
      }
    }
    console.log(JSON.stringify(results))
    return results
  }
}
