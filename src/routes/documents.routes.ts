import { Router } from "express";
import multer from "multer";
import type { AcademicExtractor } from "../services/gemini.service.js";
const signature=Buffer.from("%PDF-");
export function documentsRouter(extractor:AcademicExtractor,maxMb:number):Router{const router=Router();const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:Math.floor(maxMb*1024*1024),files:1}});router.post("/extract",upload.single("file"),async(req,res,next)=>{try{if(!req.file){res.status(400).json({error:"Envie o PDF no campo 'file'."});return;}if(req.file.mimetype!=="application/pdf"||!req.file.buffer.subarray(0,5).equals(signature)){res.status(415).json({error:"O arquivo deve ser um PDF válido."});return;}const data=await extractor.extractPdf(req.file.buffer,req.file.originalname);res.json({data,meta:{fileName:req.file.originalname,fileSize:req.file.size,eventsCount:data.events.length}});}catch(error){next(error);}});return router;}
