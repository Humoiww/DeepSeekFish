#include <node_api.h>
#include <sys/prctl.h>

NAPI_MODULE_INIT() {
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
        napi_throw_error(env, "DEV_PROCESS_NOT_PRIVATE", "Could not protect the supervisor process.");
        return NULL;
    }
    return exports;
}
