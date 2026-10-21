// Background work shares the desktop mutation lock. Use a fresh timeout after
// completion so a slow upstream cannot accumulate overlapping refreshes.
function createModelRefresh({getConfig, run, onError, setTimer=setTimeout, clearTimer=clearTimeout}) {
  let timer, stopped=false;
  function schedule() {
    if (timer !== undefined) clearTimer(timer);
    timer=undefined;
    const minutes=getConfig().modelRefreshMinutes;
    if (!stopped && minutes) {
      timer=setTimer(async()=>{timer=undefined;await attempt();schedule();},minutes*60000);
      timer?.unref?.();
    }
  }
  async function attempt() { try { await run(); } catch(error) { onError(error); } }
  return {
    async start() { if(getConfig().refreshModelsOnStartup) await attempt();schedule(); },
    reschedule: schedule,
    stop() { stopped=true;if(timer!==undefined)clearTimer(timer);timer=undefined; }
  };
}
module.exports={createModelRefresh};
