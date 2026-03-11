import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, SkipForward, Cpu, Database, Binary, Info, GitBranch, LayoutGrid, Zap, AlertTriangle, ArrowRight, Activity } from 'lucide-react';

const DEFAULT_CODE = `; ELI-512 COMPREHENSIVE DEMONSTRATION
; This code exercises every major feature proposed in the 1983 paper!
; Hover over instructions in the VLIW Grid to see Compiler Tooltips.

; --- MEMORY SETUP ---
DATA #0, #10    ; Vector A[0] (Bank 0)
DATA #1, #20    ; Vector A[1] (Bank 1)
DATA #2, #30    ; Vector A[2] (Bank 2)
DATA #3, #40    ; Vector A[3] (Bank 3)
DATA #4, #50    ; Vector A[4] (Bank 0)
DATA #10, #0    ; Pointer base

; --- 1. PARALLEL MEMORY & BANK CONFLICTS ---
; The compiler predicts banks (addr % 4). 
; Loads 1, 2, 3, 4 map to Banks 0, 1, 2, 3 and run in Cycle 0.
LOAD R1, #0     
LOAD R2, #1     
LOAD R3, #2     
LOAD R4, #3     

; #4 mod 4 = Bank 0. But Bank 0 is busy with 'LOAD R1, #0'!
; Hover over this in the grid: the compiler pushes it to Cycle 1!
LOAD R5, #4     

; --- 2. N+1 WAY JUMPS & TRACE SCHEDULING ---
; Math setup
SUB R6, R1, #10 
SUB R7, R2, #20

; ELI-512 evaluates multiple jumps in parallel using a Priority Encoder!
; If Trace Scheduling is ON, notice how the MUL ops below float 
; ABOVE these jumps into the empty ALU slots!
JNZ R6, ERR_A
JNZ R7, ERR_B

; These get hoisted past the branches!
MUL R8, R3, R4
MUL R9, R4, R5

; --- 3. UNPREDICTABLE MEMORY (Pointer Chasing) ---
; Fisher notes we can't always predict banks (e.g., pointers).
; R10 loads the pointer address.
LOAD R10, #10   

; Because R10 is a register, the compiler cannot predict the bank.
; It assumes a "MEM_ALL" dependency and safely forces this to wait 
; for ALL prior memory operations to finish.
LOAD R11, R10   
ADD R12, R11, #5

JMP SUCCESS

; --- 4. OFF-TRACE COMPENSATION CODE ---
ERR_A:
MOV R15, #1
STORE R15, #15
JMP END

ERR_B:
MOV R15, #2
STORE R15, #15
JMP END

SUCCESS:
MOV R15, #99
STORE R15, #15  ; Success flag

END:
`;

export default function App() {
  const [sourceCode, setSourceCode] = useState(DEFAULT_CODE);
  const [compiledVLIW, setCompiledVLIW] = useState([]);
  const [labelMap, setLabelMap] = useState({});
  const [pc, setPc] = useState(0);
  const [registers, setRegisters] = useState({});
  const [memory, setMemory] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [cycles, setCycles] = useState(0);
  const [riscCycles, setRiscCycles] = useState(0); // Track sequential performance
  const [compileError, setCompileError] = useState('');
  const [traceSchedulingEnabled, setTraceSchedulingEnabled] = useState(true);
  
  // Hardware Active State for Visualization
  const [activeDatapath, setActiveDatapath] = useState({
    alus: [null, null, null, null],
    banks: [false, false, false, false],
    priorityEncoder: null,
    branchTaken: false
  });

  const timerRef = useRef(null);
  const activeCycleRef = useRef(null);

  // --- Initialize CPU State ---
  const resetCPU = (initMem = {}) => {
    const freshRegs = {};
    for (let i = 0; i < 16; i++) freshRegs[`R${i}`] = 0;
    setRegisters(freshRegs);
    setMemory(initMem);
    setPc(0);
    setCycles(0);
    setRiscCycles(0);
    setIsRunning(false);
    setActiveDatapath({
      alus: [null, null, null, null],
      banks: [false, false, false, false],
      priorityEncoder: null,
      branchTaken: false
    });
  };

  useEffect(() => {
    resetCPU();
  }, []);

  // --- VLIW Compiler / Packer ---
  const compile = () => {
    setCompileError('');
    const lines = sourceCode.split('\n');
    const ops = [];
    const initMem = {};
    const extractedLabels = {};
    let pendingLabels = [];
    let opCounter = 0;

    try {
      // 1. Parse sequential code & extract labels
      lines.forEach((line) => {
        let text = line.split(';')[0].trim();
        if (!text) return;

        if (text.endsWith(':')) {
          pendingLabels.push(text.slice(0, -1));
          return;
        }

        const parts = text.split(/[\s,]+/).filter(Boolean);
        const opcode = parts[0].toUpperCase();

        if (opcode === 'DATA') {
           const addr = parseInt(parts[1].replace('#', ''));
           const val = parseInt(parts[2].replace('#', ''));
           initMem[addr] = val;
           return;
        }

        const op = { 
          id: opCounter++, 
          opcode, 
          original: text, 
          reads: [], 
          writes: [], 
          args: parts.slice(1),
          labels: pendingLabels,
          isMem: false,
          memBank: null,
          isBranch: ['JNZ', 'JMP'].includes(opcode),
          scheduleReasons: [] // For visual tooltips!
        };
        pendingLabels = [];

        const parseArg = (arg) => {
          if (!arg) return null;
          if (arg.startsWith('R')) return { type: 'REG', val: arg };
          if (arg.startsWith('#')) return { type: 'IMM', val: parseInt(arg.substring(1)) };
          return { type: 'LABEL', val: arg };
        };

        if (['ADD', 'SUB', 'MUL'].includes(opcode)) {
          op.dest = parseArg(parts[1]);
          op.src1 = parseArg(parts[2]);
          op.src2 = parseArg(parts[3]);
          op.writes.push(op.dest.val);
          if (op.src1?.type === 'REG') op.reads.push(op.src1.val);
          if (op.src2?.type === 'REG') op.reads.push(op.src2.val);
        } else if (opcode === 'MOV') {
          op.dest = parseArg(parts[1]);
          op.src1 = parseArg(parts[2]);
          op.writes.push(op.dest.val);
          if (op.src1?.type === 'REG') op.reads.push(op.src1.val);
        } else if (opcode === 'LOAD') {
          op.isMem = true;
          op.dest = parseArg(parts[1]);
          op.addr = parseArg(parts[2]);
          op.writes.push(op.dest.val);
          if (op.addr.type === 'REG') {
            op.reads.push(op.addr.val);
            op.reads.push('MEM_ALL');
          } else {
            op.reads.push(`MEM_${op.addr.val}`);
            op.memBank = op.addr.val % 4;
          }
        } else if (opcode === 'STORE') {
          op.isMem = true;
          op.src1 = parseArg(parts[1]);
          op.addr = parseArg(parts[2]);
          if (op.src1.type === 'REG') op.reads.push(op.src1.val);
          if (op.addr.type === 'REG') {
            op.reads.push(op.addr.val);
            op.writes.push('MEM_ALL');
          } else {
            op.writes.push(`MEM_${op.addr.val}`);
            op.memBank = op.addr.val % 4;
          }
        } else if (opcode === 'JNZ') {
          op.src1 = parseArg(parts[1]);
          op.target = parseArg(parts[2]);
          if (op.src1.type === 'REG') op.reads.push(op.src1.val);
        } else if (opcode === 'JMP') {
          op.target = parseArg(parts[1]);
        } else {
          throw new Error(`Unknown opcode ${opcode}`);
        }
        ops.push(op);
      });

      // 2. Schedule & Pack
      const vliwSlots = []; 
      const finalLabels = {};

      ops.forEach(op => {
        let earliestCycle = 0;
        
        // 2a. Data Dependencies (RAW, WAR, WAW)
        for (let cycle = 0; cycle < vliwSlots.length; cycle++) {
          vliwSlots[cycle].forEach(prevOp => {
            const raw = op.reads.find(r => prevOp.writes.includes(r) || prevOp.writes.includes('MEM_ALL') || r === 'MEM_ALL');
            const waw = op.writes.find(w => prevOp.writes.includes(w) || prevOp.writes.includes('MEM_ALL') || w === 'MEM_ALL');
            
            // RAW and WAW require delay to next cycle.
            // WAR (anti-dependency) is safe: VLIW read-before-write semantics
            // guarantee the old value is read before the new value is written.
            if (raw || waw) {
              const reason = raw ? `RAW on ${raw}` : `WAW on ${waw}`;
              if (cycle + 1 > earliestCycle) {
                earliestCycle = cycle + 1;
                op.scheduleReasons = [`Delayed by ${reason} from '${prevOp.original}' (Cycle ${cycle})`];
              } else if (cycle + 1 === earliestCycle) {
                op.scheduleReasons.push(`Delayed by ${reason} from '${prevOp.original}'`);
              }
            }
          });
        }

        // 2b. Basic Block / Trace Scheduling Constraints
        let latestBranchCycle = -1;
        let latestOpCycle = -1;

        for (let cycle = 0; cycle < vliwSlots.length; cycle++) {
          vliwSlots[cycle].forEach(prevOp => {
            if (prevOp.id < op.id) {
              latestOpCycle = Math.max(latestOpCycle, cycle);
              if (prevOp.isBranch) {
                latestBranchCycle = Math.max(latestBranchCycle, cycle);
              }
            }
          });
        }

        if (!traceSchedulingEnabled) {
          if (latestBranchCycle >= earliestCycle) {
            if (latestBranchCycle + 1 > earliestCycle) {
              earliestCycle = latestBranchCycle + 1;
              op.scheduleReasons = [`Basic Block Barrier: Cannot float past branch (Cycle ${latestBranchCycle})`];
            }
          }
        } else {
          if (op.labels.length > 0 && latestBranchCycle >= earliestCycle) {
            earliestCycle = latestBranchCycle + 1;
            op.scheduleReasons = [`Control Flow: Branch target cannot float above prior branch`];
          }
          if (op.isBranch && latestOpCycle >= earliestCycle) {
            earliestCycle = Math.max(earliestCycle, latestOpCycle);
            op.scheduleReasons.push(`Control Flow: Branch cannot float above operations`);
          }
        }

        // 2c. Structural Hazards (ALU Slots & Memory Banks)
        while (true) {
          if (!vliwSlots[earliestCycle]) vliwSlots[earliestCycle] = [];
          
          let hasSpace = vliwSlots[earliestCycle].length < 4;
          let bankConflict = false;
          let bankConflictOp = null;
          let wawSameCycle = false;

          vliwSlots[earliestCycle].forEach(prevOp => {
             if (op.writes.some(w => prevOp.writes.includes(w))) wawSameCycle = true;
             if (op.isMem && prevOp.isMem) {
               if (op.memBank !== null && prevOp.memBank !== null && op.memBank === prevOp.memBank) {
                 bankConflict = true; bankConflictOp = prevOp;
               }
               if (op.memBank === null || prevOp.memBank === null) bankConflict = true;
             }
          });

          if (!hasSpace) {
             if (op.scheduleReasons.length === 0 || !op.scheduleReasons[0].includes("ALUs full")) {
               op.scheduleReasons = [`Structural Hazard: Cycle ${earliestCycle} ALUs are full.`];
             }
             earliestCycle++;
          } else if (bankConflict) {
             op.scheduleReasons = [`Structural Hazard: Bank Conflict (Bank ${op.memBank}) with '${bankConflictOp.original}'`];
             earliestCycle++;
          } else if (wawSameCycle) {
             earliestCycle++;
          } else {
            op.cycle = earliestCycle;
            if (op.scheduleReasons.length === 0) op.scheduleReasons = ["Scheduled as early as possible (No hazards)"];
            vliwSlots[earliestCycle].push(op);
            op.labels.forEach(l => finalLabels[l] = earliestCycle);
            break;
          }
        }
      });

      pendingLabels.forEach(l => finalLabels[l] = vliwSlots.length);
      setCompiledVLIW(vliwSlots);
      setLabelMap(finalLabels);
      resetCPU(initMem);
      
    } catch (err) {
      setCompileError(err.message);
    }
  };

  useEffect(() => { compile(); }, [traceSchedulingEnabled]);

  // --- Hardware Execution Engine ---
  const stepVLIW = () => {
    if (pc >= compiledVLIW.length) {
      setIsRunning(false);
      setActiveDatapath({ alus: [null,null,null,null], banks: [false,false,false,false], priorityEncoder: null, branchTaken: false });
      return;
    }

    const currentVLIW = compiledVLIW[pc];
    let nextRegs = { ...registers };
    let nextMem = { ...memory };
    let nextPc = pc + 1;
    let branchTaken = false;
    let jumpTarget = null;
    let branchEvaluated = false;
    let firstTakenBranchId = Infinity;

    // Visual State Tracking
    const activeAlus = [null, null, null, null];
    const activeBanks = [false, false, false, false];

    // Priority Encoder sorting
    const sortedOps = [...currentVLIW].sort((a, b) => a.id - b.id);

    const execResults = sortedOps.map(op => {
      const getVal = (arg) => {
        if (arg.type === 'IMM') return arg.val;
        if (arg.type === 'REG') return registers[arg.val] || 0;
        return 0;
      };

      let result = null;
      let writeTarget = null; 
      
      // Find original index for visualizer mapping
      const aluIdx = currentVLIW.findIndex(o => o.id === op.id);
      activeAlus[aluIdx] = op.opcode;

      if (op.isMem && op.memBank !== null) {
        activeBanks[op.memBank] = true;
      }

      switch (op.opcode) {
        case 'ADD':
          result = getVal(op.src1) + getVal(op.src2);
          writeTarget = { type: 'REG', name: op.dest.val };
          break;
        case 'SUB':
          result = getVal(op.src1) - getVal(op.src2);
          writeTarget = { type: 'REG', name: op.dest.val };
          break;
        case 'MUL':
          result = getVal(op.src1) * getVal(op.src2);
          writeTarget = { type: 'REG', name: op.dest.val };
          break;
        case 'MOV':
          result = getVal(op.src1);
          writeTarget = { type: 'REG', name: op.dest.val };
          break;
        case 'LOAD':
          const loadAddr = getVal(op.addr);
          result = memory[loadAddr] || 0;
          writeTarget = { type: 'REG', name: op.dest.val };
          break;
        case 'STORE':
          result = getVal(op.src1);
          const storeAddr = getVal(op.addr);
          writeTarget = { type: 'MEM', name: storeAddr };
          break;
        case 'JNZ':
          branchEvaluated = true;
          if (!branchTaken && getVal(op.src1) !== 0) {
            nextPc = labelMap[op.target.val] ?? pc + 1;
            branchTaken = true;
            jumpTarget = op.target.val;
            firstTakenBranchId = op.id;
          }
          break;
        case 'JMP':
          branchEvaluated = true;
          if (!branchTaken) {
            nextPc = labelMap[op.target.val] ?? pc + 1;
            branchTaken = true;
            jumpTarget = op.target.val;
            firstTakenBranchId = op.id;
          }
          break;
        default:
          break;
      }
      return { result, writeTarget, opId: op.id };
    });

    // Only commit writes for ops that precede the first taken branch in
    // program order. Ops speculatively moved above branches by trace
    // scheduling must not commit when the branch fires (models the
    // compensation/recovery code described in Fisher's paper).
    execResults.forEach(({ result, writeTarget, opId }) => {
      if (opId < firstTakenBranchId) {
        if (writeTarget?.type === 'REG') nextRegs[writeTarget.name] = result;
        else if (writeTarget?.type === 'MEM') nextMem[writeTarget.name] = result;
      }
    });

    setRegisters(nextRegs);
    setMemory(nextMem);
    setPc(nextPc);
    setCycles(cycles + 1);
    // RISC equivalent: count only ops that would execute sequentially
    // (ops before the taken branch + the branch itself; skip speculative ops)
    const effectiveOps = branchTaken
      ? sortedOps.filter(op => op.id <= firstTakenBranchId).length
      : sortedOps.length;
    setRiscCycles(riscCycles + effectiveOps);
    
    setActiveDatapath({
      alus: activeAlus,
      banks: activeBanks,
      priorityEncoder: branchEvaluated ? (branchTaken ? `Target: ${jumpTarget}` : 'No Jump') : null,
      branchTaken: branchTaken
    });
  };

  useEffect(() => {
    if (activeCycleRef.current) {
      activeCycleRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [pc]);

  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(stepVLIW, 1200); // Slower for visual tracing
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isRunning, pc, compiledVLIW, registers, memory]);

  const isFinished = pc >= compiledVLIW.length && compiledVLIW.length > 0;
  const memoryBanks = [0, 1, 2, 3].map(bankId => 
    Object.entries(memory).filter(([addr]) => parseInt(addr) % 4 === bankId)
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-6 font-sans flex flex-col">
      {/* Header Area */}
      <header className="mb-4 flex flex-col lg:flex-row lg:items-center justify-between border-b border-slate-800 pb-4 gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3 text-blue-400">
            <Cpu className="w-8 h-8" />
            ELI-512 VLIW Visualizer
          </h1>
          <p className="text-slate-400 mt-2 text-sm max-w-3xl leading-relaxed">
            Interactive visualization of Joseph A. Fisher's 1983 architecture. Features compiler dependency analysis, 
            memory bank predictions, and the N+1 Priority Encoder datapath.
          </p>
        </div>
        <div className="flex items-center gap-4 bg-slate-900 p-3 rounded-xl border border-slate-700 shadow-xl">
          <label className="flex items-center gap-2 cursor-pointer p-2 hover:bg-slate-800 rounded transition-colors border border-slate-800" title="Toggle global compaction. Watch instructions float above branches!">
            <input 
              type="checkbox" className="sr-only" 
              checked={traceSchedulingEnabled}
              onChange={(e) => setTraceSchedulingEnabled(e.target.checked)} 
            />
            <div className={`relative w-10 h-6 rounded-full transition-colors ${traceSchedulingEnabled ? 'bg-emerald-500' : 'bg-slate-600'}`}>
              <div className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${traceSchedulingEnabled ? 'translate-x-4' : ''}`} />
            </div>
            <span className="text-sm font-bold tracking-wide">
              {traceSchedulingEnabled ? <span className="text-emerald-400">Trace Scheduling ON</span> : <span className="text-slate-400">Basic Block Mode</span>}
            </span>
          </label>
          <div className="h-8 w-px bg-slate-700"></div>
          
          {/* COMPARISON METRICS */}
          <div className="flex gap-4 px-2 text-center">
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">RISC Cycles</div>
              <div className="text-xl font-mono font-bold text-slate-300">{riscCycles}</div>
            </div>
            <div className="text-slate-600 text-2xl font-light">/</div>
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">VLIW Cycles</div>
              <div className="text-xl font-mono font-bold text-blue-400">{cycles}</div>
            </div>
            <div className="text-slate-600 text-2xl font-light">=</div>
            <div>
              <div className="text-[10px] text-amber-500/80 uppercase tracking-widest font-bold">Speedup</div>
              <div className="text-xl font-mono font-bold text-amber-400">
                {cycles > 0 ? (riscCycles / cycles).toFixed(1) : '0.0'}x
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 xl:grid-cols-12 gap-4">
        
        {/* Left Column: Code Editor */}
        <section className="col-span-1 xl:col-span-3 flex flex-col gap-4">
          <div className="flex flex-col bg-slate-900 rounded-xl border border-slate-700 shadow-xl overflow-hidden flex-1">
            <div className="bg-slate-800/80 p-3 border-b border-slate-700 flex justify-between items-center">
              <h2 className="font-semibold text-slate-200 flex items-center gap-2">
                <Binary className="w-4 h-4 text-blue-400" /> Source Assembly
              </h2>
              <button onClick={compile} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium transition-colors shadow-lg shadow-blue-900/20 flex items-center gap-2">
                <Zap className="w-4 h-4" /> Compile
              </button>
            </div>
            {compileError && <div className="bg-red-900/80 text-red-100 p-3 text-sm border-b border-red-800 font-mono">{compileError}</div>}
            <textarea
              className="flex-1 bg-[#090e17] text-slate-300 font-mono text-sm p-4 outline-none resize-y min-h-[150px] leading-relaxed custom-scrollbar"
              value={sourceCode}
              onChange={(e) => setSourceCode(e.target.value)}
              spellCheck="false"
            />
          </div>
        </section>

        {/* Middle Column: Visualizer Pipeline & Hardware Diagram */}
        <section className="col-span-1 xl:col-span-6 flex flex-col gap-4">
          
          {/* HARDWARE DATAPATH VISUALIZER */}
          <div className="bg-slate-900 rounded-xl border border-slate-700 shadow-xl p-4 flex flex-col gap-4 relative overflow-hidden">
            <h2 className="font-semibold text-slate-200 flex items-center gap-2 absolute top-3 left-3">
              <Activity className="w-4 h-4 text-emerald-400" /> Active Hardware Datapath
            </h2>
            
            <div className="mt-6 grid grid-cols-4 gap-4">
              {/* ALUs */}
              <div className="col-span-4 flex justify-between gap-2">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className={`flex-1 p-2 rounded-lg border-2 text-center transition-all duration-300 ${
                    activeDatapath.alus[i] ? 'bg-blue-900/50 border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)] scale-105' : 'bg-slate-800 border-slate-700 opacity-50'
                  }`}>
                    <div className="text-[10px] text-slate-400 font-bold mb-1">ALU SLOT {i+1}</div>
                    <div className="font-mono text-sm font-bold text-white">{activeDatapath.alus[i] || 'IDLE'}</div>
                  </div>
                ))}
              </div>

              {/* Data paths (Arrows) */}
              <div className="col-span-4 flex justify-center py-2 text-slate-600">
                <ArrowRight className="w-6 h-6 rotate-90" />
              </div>

              {/* Bottom Layer: Priority Encoder & Memory Banks */}
              <div className="col-span-4 grid grid-cols-12 gap-4">
                {/* Priority Encoder (N+1 Jump) */}
                <div className={`col-span-4 p-3 rounded-lg border-2 flex flex-col items-center justify-center text-center transition-all duration-300 ${
                  activeDatapath.priorityEncoder ? (activeDatapath.branchTaken ? 'bg-amber-900/50 border-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.5)]' : 'bg-slate-800 border-amber-500/50') : 'bg-slate-800 border-slate-700 opacity-50'
                }`}>
                  <div className="text-[10px] text-slate-400 font-bold mb-1">N+1 PRIORITY ENCODER</div>
                  <div className={`font-mono text-xs font-bold ${activeDatapath.branchTaken ? 'text-amber-400' : 'text-slate-500'}`}>
                    {activeDatapath.priorityEncoder || 'IDLE'}
                  </div>
                </div>

                {/* Interleaved Memory */}
                <div className="col-span-8 grid grid-cols-4 gap-2">
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} className={`p-2 rounded-lg border-2 text-center transition-all duration-300 ${
                      activeDatapath.banks[i] ? 'bg-fuchsia-900/50 border-fuchsia-400 shadow-[0_0_15px_rgba(232,121,249,0.5)] scale-105' : 'bg-slate-800 border-slate-700 opacity-50'
                    }`}>
                      <Database className={`w-4 h-4 mx-auto mb-1 ${activeDatapath.banks[i] ? 'text-fuchsia-400' : 'text-slate-500'}`} />
                      <div className="text-[10px] font-bold text-slate-400">BANK {i}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* VLIW PIPELINE GRID */}
          <div className="bg-slate-900 rounded-xl border border-slate-700 shadow-xl overflow-hidden flex-1 flex flex-col">
            <div className="bg-slate-800/80 p-3 border-b border-slate-700 flex justify-between items-center">
              <h2 className="font-semibold text-slate-200 flex items-center gap-2">
                <LayoutGrid className="w-4 h-4 text-blue-400" /> Compiled VLIW Schedule
              </h2>
              <div className="flex gap-2">
                <button onClick={() => { setIsRunning(false); stepVLIW(); }} disabled={isRunning || isFinished} className="p-1.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-200 disabled:opacity-50 transition-colors">
                  <SkipForward className="w-4 h-4" />
                </button>
                <button onClick={() => setIsRunning(!isRunning)} disabled={isFinished} className={`p-1.5 rounded text-white disabled:opacity-50 transition-colors ${isRunning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
                  {isRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <button onClick={compile} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm font-medium transition-colors">Reset</button>
              </div>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto bg-[#0a0f18] custom-scrollbar">
              {compiledVLIW.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600 flex-col gap-4">
                  <Info className="w-10 h-10 opacity-50" />
                  <p>Click Compile to generate VLIW trace.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-12 gap-2 text-[10px] font-bold text-slate-500 mb-1 px-2 uppercase tracking-widest">
                    <div className="col-span-1 text-center">Cycle</div>
                    <div className="col-span-2">Labels</div>
                    <div className="col-span-9 grid grid-cols-4 gap-2">
                      <div>ALU 1</div><div>ALU 2</div><div>ALU 3</div><div>ALU 4</div>
                    </div>
                  </div>
                  
                  {compiledVLIW.map((slotData, cycleIndex) => {
                    const isActive = pc === cycleIndex;
                    const isPast = pc > cycleIndex;
                    const labelsInCycle = Object.entries(labelMap).filter(([_, c]) => c === cycleIndex).map(([l]) => l);

                    return (
                      <div key={cycleIndex} ref={isActive ? activeCycleRef : null} className={`grid grid-cols-12 gap-2 p-2 rounded-lg border transition-all duration-300 ${
                          isActive ? 'bg-blue-900/20 border-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.15)] scale-[1.01]' : 
                          isPast ? 'bg-slate-800/20 border-slate-800/50 opacity-50' : 
                          'bg-slate-800/50 border-slate-700'
                        }`}
                      >
                        <div className={`col-span-1 flex items-center justify-center font-mono font-bold text-lg ${isActive ? 'text-blue-400' : 'text-slate-600'}`}>
                          {cycleIndex}
                        </div>
                        
                        <div className="col-span-2 flex flex-col justify-center gap-1 border-r border-slate-700/50 pr-2">
                          {labelsInCycle.map(l => (
                            <div key={l} className="text-[10px] bg-slate-800 text-amber-400 px-1.5 py-0.5 rounded font-mono truncate border border-slate-700">
                              {l}:
                            </div>
                          ))}
                        </div>

                        <div className="col-span-9 grid grid-cols-4 gap-2">
                          {[0, 1, 2, 3].map(aluIndex => {
                            const op = slotData[aluIndex];
                            return (
                              <div key={aluIndex} className="relative group">
                                <div className={`flex items-center p-2 rounded font-mono text-[11px] xl:text-xs border h-full cursor-help ${
                                    op ? 
                                    (isActive ? (op.isMem ? 'bg-fuchsia-900/40 border-fuchsia-500/50 text-fuchsia-100' : op.isBranch ? 'bg-amber-900/40 border-amber-500/50 text-amber-100' : 'bg-blue-800/40 border-blue-400/50 text-blue-100') : 
                                                'bg-slate-800 border-slate-600 text-slate-300 hover:border-blue-400 transition-colors') : 
                                    'bg-transparent border-dashed border-slate-700/50 text-slate-700'
                                  }`}
                                >
                                  {op ? op.original : 'NOP'}
                                </div>
                                
                                {/* COMPILER REASON TOOLTIP */}
                                {op && (
                                  <div className="absolute z-50 left-0 bottom-full mb-2 w-64 p-3 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                    <div className="text-xs font-bold text-slate-300 border-b border-slate-700 pb-1 mb-2">Compiler Analysis</div>
                                    <ul className="text-[10px] text-slate-400 flex flex-col gap-1">
                                      {op.scheduleReasons.map((reason, i) => (
                                        <li key={i} className="flex gap-1 items-start">
                                          {reason.includes('Hazard') || reason.includes('Conflict') ? <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" /> : <Info className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" />}
                                          <span className={reason.includes('Hazard') || reason.includes('Conflict') ? 'text-red-300' : ''}>{reason}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Registers & Memory UI */}
        <section className="col-span-1 xl:col-span-3 flex flex-col gap-4">
          <div className="bg-slate-900 rounded-xl border border-slate-700 shadow-xl flex-1 flex flex-col overflow-hidden max-h-[40vh]">
             <div className="bg-slate-800/80 p-3 border-b border-slate-700">
               <h2 className="font-semibold text-slate-200 flex items-center gap-2">
                 <Database className="w-4 h-4 text-blue-400" /> Registers
               </h2>
             </div>
             <div className="p-3 grid grid-cols-2 gap-2 overflow-y-auto custom-scrollbar bg-[#090e17]">
                {Array.from({length: 16}).map((_, i) => (
                  <div key={`R${i}`} className="flex justify-between items-center bg-slate-900 p-2 rounded border border-slate-800">
                    <span className="text-[10px] font-bold text-slate-500">R{i}</span>
                    <span className={`font-mono text-xs ${registers[`R${i}`] !== 0 ? 'text-blue-400 font-bold' : 'text-slate-600'}`}>{registers[`R${i}`] || 0}</span>
                  </div>
                ))}
             </div>
          </div>

          <div className="bg-slate-900 rounded-xl border border-slate-700 shadow-xl flex-1 flex flex-col overflow-hidden">
             <div className="bg-slate-800/80 p-3 border-b border-slate-700 flex justify-between items-center">
               <h2 className="font-semibold text-slate-200 flex items-center gap-2">
                 <GitBranch className="w-4 h-4 text-fuchsia-400" /> Memory Banks
               </h2>
             </div>
             <div className="p-3 grid grid-cols-4 gap-2 h-full bg-[#090e17]">
                {[0, 1, 2, 3].map(bankId => (
                  <div key={bankId} className="flex flex-col bg-slate-900 border border-slate-800 rounded overflow-hidden">
                    <div className="bg-slate-800 text-[10px] text-center font-bold text-slate-400 py-1 uppercase tracking-widest border-b border-slate-700">B{bankId}</div>
                    <div className="p-1 flex flex-col gap-1 overflow-y-auto custom-scrollbar">
                      {memoryBanks[bankId].map(([addr, val]) => (
                        <div key={addr} className="flex flex-col items-center bg-slate-950 p-1 rounded border border-slate-800">
                          <span className="text-[9px] text-slate-600">[{addr}]</span>
                          <span className="font-mono text-xs text-fuchsia-400 font-bold">{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
             </div>
          </div>
        </section>
      </main>

    </div>
  );
}