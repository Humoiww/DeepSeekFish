param([Parameter(Mandatory=$true)][string]$CommandBase64,[Parameter(Mandatory=$true)][int]$OwnerPid)
$ErrorActionPreference = 'Stop'
# Dedicated Windows Job Object: descendants are assigned before any child code
# executes. Closing this launcher kills the complete process tree.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FishJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended data,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,System.Text.StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint ms);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string command,uint ownerPid) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); Info pi=new Info();
    if(job==IntPtr.Zero) throw new Exception("JOB_CREATE_FAILED");
    IntPtr owner=OpenProcess(0x100000,false,ownerPid);
    if(owner==IntPtr.Zero){CloseHandle(job);throw new Exception("JOB_OWNER_UNAVAILABLE");}
    try {
      var limit=new Extended(); limit.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway
      if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(Extended))))throw new Exception("JOB_CONFIG_FAILED");
      var si=new Startup();si.cb=(uint)Marshal.SizeOf(typeof(Startup));si.flags=0x100;
      si.input=GetStdHandle(-10);si.output=GetStdHandle(-11);si.error=GetStdHandle(-12);
      if(!CreateProcess(null,new System.Text.StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out pi))throw new Exception("JOB_SPAWN_FAILED");
      if(!AssignProcessToJobObject(job,pi.process)){TerminateProcess(pi.process,1);throw new Exception("JOB_ASSIGN_FAILED");}
      if(ResumeThread(pi.thread)==0xffffffff){TerminateProcess(pi.process,1);throw new Exception("JOB_RESUME_FAILED");}
      uint completed=WaitForMultipleObjects(2,new IntPtr[]{pi.process,owner},false,0xffffffff);
      if(completed!=0)return 1;
      uint code;GetExitCodeProcess(pi.process,out code);return (int)code;
    } finally {CloseHandle(job);CloseHandle(owner);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);}
  }
}
'@
$line = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($CommandBase64))
exit [FishJob]::Run($line, [uint32]$OwnerPid)
